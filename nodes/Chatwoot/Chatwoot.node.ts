import type {
	Icon,
	IDataObject,
	IExecuteSingleFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';

// ──────────────────────────────────────────────────────────────────────
//   Helper: Create or Update Contact (Respond.io-style)
//   Hybrid declarative + preSend hook. Faz search pelo identifier antes
//   da request principal e decide method (POST create / PUT update).
// ──────────────────────────────────────────────────────────────────────

interface ChatwootCredentialsData {
	baseUrl: string;
	accountId: string;
	apiAccessToken: string;
}

// Base URL fixa do ChatBot. UI da credencial pede SÓ a API Key —
// baseUrl e accountId são resolvidos aqui automaticamente.
const CHATBOT_BASE_URL = 'https://app.chatbotx1.com';

// Cache de accountId por token. Como o token é gerado pra um único
// usuário-integração de uma única conta, o lookup só roda 1× por token
// na vida do worker n8n. Map module-level sobrevive entre executions.
const __accountIdCache = new Map<string, string>();

/**
 * Resolve as credenciais completas a partir do token. Faz GET /api/v1/profile
 * (cacheado) pra descobrir o accountId vinculado ao token.
 *
 * Usar em todo helper async (loadOptions, preSend, resourceMapper) no lugar
 * de `await this.getCredentials('chatwootApi')`.
 *
 * Routing-style operations (URL com `={{$credentials.accountId}}`) NÃO
 * precisam desse helper — `preAuthentication` da credencial injeta os
 * valores resolvidos antes de cada request autenticado.
 */
async function resolveChatwootCredentials(this: any): Promise<ChatwootCredentialsData> {
	const raw = (await this.getCredentials('chatwootApi')) as { apiAccessToken: string };
	const apiAccessToken = raw.apiAccessToken;

	let accountId = __accountIdCache.get(apiAccessToken);
	if (!accountId) {
		const profile = (await this.helpers.httpRequest({
			method: 'GET',
			url: `${CHATBOT_BASE_URL}/api/v1/profile`,
			headers: { api_access_token: apiAccessToken },
			json: true,
		})) as { account_id?: number | string; accounts?: Array<{ id: number | string }> };

		accountId = String(profile.account_id ?? profile.accounts?.[0]?.id ?? '1');
		__accountIdCache.set(apiAccessToken, accountId);
	}

	return { baseUrl: CHATBOT_BASE_URL, accountId, apiAccessToken };
}

const CONTACT_CUSTOM_ATTR_MODEL = 1; // 0=Conversation, 1=Contact (Chatwoot enum)

// Mapa attribute_display_type → tipo do resourceMapper (n8n FieldType).
// Chatwoot: 0=Text 1=Number 2=Currency 3=Percent 4=Link 5=Date 6=List 7=Checkbox.
const ATTRIBUTE_TYPE_MAP: Record<number, ResourceMapperField['type']> = {
	0: 'string',
	1: 'number',
	2: 'number',
	3: 'number',
	4: 'string',
	5: 'dateTime',
	6: 'options',
	7: 'boolean',
};

async function getCustomAttributesForContactMapper(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const credentials = await resolveChatwootCredentials.call(this);
	const url = `${credentials.baseUrl}/api/v1/accounts/${credentials.accountId}/custom_attribute_definitions`;

	const response = await this.helpers.httpRequestWithAuthentication.call(this, 'chatwootApi', {
		method: 'GET',
		url,
		qs: { attribute_model: CONTACT_CUSTOM_ATTR_MODEL },
		json: true,
	});

	// Chatwoot devolve a lista direta como array OU envelopada em { payload: [...] }
	// dependendo da versão. Cobrimos ambas formas.
	const definitions: IDataObject[] = Array.isArray(response)
		? (response as IDataObject[])
		: ((response as IDataObject)?.payload as IDataObject[]) || [];

	// Chatwoot attribute_display_type vem como string ('text', 'number', ...) em versões
	// recentes OU número (0-7) em versões antigas. Cobrimos as duas formas.
	const STRING_TYPE_MAP: Record<string, ResourceMapperField['type']> = {
		text: 'string',
		number: 'number',
		currency: 'number',
		percent: 'number',
		link: 'string',
		date: 'dateTime',
		list: 'options',
		checkbox: 'boolean',
	};

	const fields: ResourceMapperField[] = definitions.map((attr) => {
		const raw = attr.attribute_display_type;
		const typeStr = typeof raw === 'string' ? raw.toLowerCase() : '';
		const typeNum = typeof raw === 'number' ? raw : Number(raw ?? 0);
		const mappedType = STRING_TYPE_MAP[typeStr] || ATTRIBUTE_TYPE_MAP[typeNum] || 'string';

		const key = String(attr.attribute_key ?? '');
		const label = String(attr.attribute_display_name ?? key);
		const values = Array.isArray(attr.attribute_values) ? (attr.attribute_values as string[]) : [];
		const isList = mappedType === 'options';

		return {
			id: key,
			displayName: label,
			required: false,
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			type: mappedType,
			options: isList && values.length ? values.map((v) => ({ name: v, value: v })) : undefined,
		};
	});

	return { fields };
}

// Detecta celular brasileiro (+55 DDD 8 ou 9 dígitos) e devolve a variante
// invertida: se veio com o 9 inicial após o DDD, devolve sem; se veio sem,
// devolve com. Útil pra cobrir bases legadas onde alguns contatos foram
// cadastrados no formato pré-2014 (sem o 9) e webhooks atuais mandam o
// formato pós-Anatel (com o 9). Retorna null se não for BR mobile reconhecido.
function brPhoneVariant(phone: string): string | null {
	const match = phone.match(/^\+55(\d{2})(\d{8,9})$/);
	if (!match) return null;
	const [, ddd, num] = match;
	if (num.length === 9 && num.startsWith('9')) {
		return `+55${ddd}${num.substring(1)}`;
	}
	if (num.length === 8) {
		return `+55${ddd}9${num}`;
	}
	return null;
}

// Busca contato no Chatwoot pelo identifier (phone_number ou identifier).
// Aplica fallback BR: se identifier é phone E formato BR mobile, tenta também
// a variante com/sem o 9 inicial pra cobrir bases legadas.
// Retorna o contato encontrado OU null.
async function searchContactByIdentifier(
	this: IExecuteSingleFunctions,
	baseUrl: string,
	accountId: string,
	identifierType: 'phone_number' | 'identifier',
	identifierValue: string,
): Promise<IDataObject | null> {
	const candidates = [identifierValue];
	if (identifierType === 'phone_number') {
		const variant = brPhoneVariant(identifierValue);
		if (variant && !candidates.includes(variant)) candidates.push(variant);
	}

	for (const query of candidates) {
		try {
			const response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'chatwootApi',
				{
					method: 'GET',
					url: `${baseUrl}/api/v1/accounts/${accountId}/contacts/search`,
					qs: { q: query, include: 'contact_inboxes' },
					json: true,
				},
			)) as IDataObject;

			const payload = (response?.payload as IDataObject[]) || [];
			const match = payload.find((c) => {
				if (identifierType === 'phone_number') {
					return c.phone_number === query;
				}
				return c.identifier === query;
			});
			if (match) return match;
		} catch {
			// Tenta a próxima variante silenciosamente.
		}
	}
	return null;
}

// Lê os campos comuns (createOrUpdateXxx + valuesToSend) e devolve body pronto.
function buildContactBody(
	this: IExecuteSingleFunctions,
	identifierType: 'phone_number' | 'identifier',
	identifierValue: string,
): IDataObject {
	const firstName = ((this.getNodeParameter('createOrUpdateFirstName', '') as string) || '').trim();
	const lastName = ((this.getNodeParameter('createOrUpdateLastName', '') as string) || '').trim();
	const email = ((this.getNodeParameter('createOrUpdateEmail', '') as string) || '').trim();
	const phoneNumber = ((this.getNodeParameter('createOrUpdatePhoneNumber', '') as string) || '').trim();

	const valuesToSendRaw = this.getNodeParameter('createOrUpdateValuesToSend', {}) as
		| IDataObject
		| undefined;
	const customAttributes =
		(valuesToSendRaw && (valuesToSendRaw.value as IDataObject)) || ({} as IDataObject);

	const fullName = `${firstName} ${lastName}`.trim();
	const body: IDataObject = {};
	if (fullName) body.name = fullName;
	if (email) body.email = email;
	if (phoneNumber) body.phone_number = phoneNumber;
	else if (identifierType === 'phone_number') body.phone_number = identifierValue;
	if (identifierType === 'identifier') body.identifier = identifierValue;
	if (Object.keys(customAttributes).length) body.custom_attributes = customAttributes;

	return body;
}

// preSend pro Create or Update: search (com fallback BR) → POST se não achou,
// PUT se achou. Nunca falha por "contato não encontrado".
async function createOrUpdateContactPreSend(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const credentials = await resolveChatwootCredentials.call(this);
	const { baseUrl, accountId } = credentials;

	const identifierType = this.getNodeParameter('createOrUpdateIdentifierType') as
		| 'phone_number'
		| 'identifier';
	const identifierValue = (this.getNodeParameter('createOrUpdateIdentifier') as string)?.trim();
	if (!identifierValue) {
		throw new Error('Contact Identifier não pode ser vazio.');
	}

	const existing = await searchContactByIdentifier.call(
		this,
		baseUrl,
		accountId,
		identifierType,
		identifierValue,
	);
	const body = buildContactBody.call(this, identifierType, identifierValue);

	if (existing) {
		requestOptions.method = 'PUT';
		requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/contacts/${existing.id}`;
	} else {
		requestOptions.method = 'POST';
		requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/contacts`;
	}
	requestOptions.body = body;

	return requestOptions;
}

// preSend pro Update: search (com fallback BR) → PUT. Joga erro se não achou.
async function updateContactPreSend(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const credentials = await resolveChatwootCredentials.call(this);
	const { baseUrl, accountId } = credentials;

	const identifierType = this.getNodeParameter('createOrUpdateIdentifierType') as
		| 'phone_number'
		| 'identifier';
	const identifierValue = (this.getNodeParameter('createOrUpdateIdentifier') as string)?.trim();
	if (!identifierValue) {
		throw new Error('Contact Identifier não pode ser vazio.');
	}

	const existing = await searchContactByIdentifier.call(
		this,
		baseUrl,
		accountId,
		identifierType,
		identifierValue,
	);
	if (!existing) {
		throw new Error(
			`Update Contact: nenhum contato encontrado com ${identifierType}="${identifierValue}". Use "Create or Update" se quiser criar quando não existir.`,
		);
	}

	const body = buildContactBody.call(this, identifierType, identifierValue);
	requestOptions.method = 'PUT';
	requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/contacts/${existing.id}`;
	requestOptions.body = body;

	return requestOptions;
}

// postReceive: normaliza a resposta — Chatwoot envolve em { data: {...} } no create
// e retorna { payload: {...} } no update. Sempre devolvemos { contact: {...} }.
async function createOrUpdateContactPostReceive(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	_response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	return items.map((item) => {
		const raw = item.json as IDataObject;
		const contact = (raw?.data || raw?.payload || raw) as IDataObject;
		return { json: { contact } };
	});
}

// loadOptions: lista labels da conta pra dropdowns multiOptions. Cacheado por sessão
// (refresh manual via 3-dots).
async function getLabelsForContact(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await resolveChatwootCredentials.call(this);
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'chatwootApi', {
		method: 'GET',
		url: `${credentials.baseUrl}/api/v1/accounts/${credentials.accountId}/labels`,
		json: true,
	})) as IDataObject;

	const labels = (response?.payload as IDataObject[]) || [];
	return labels.map((label) => ({
		name: String(label.title ?? label.id),
		value: String(label.title ?? ''),
	}));
}

// loadOptions: lista agentes da conta pra dropdown de assign.
async function getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const credentials = await resolveChatwootCredentials.call(this);
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'chatwootApi', {
		method: 'GET',
		url: `${credentials.baseUrl}/api/v1/accounts/${credentials.accountId}/agents`,
		json: true,
	})) as IDataObject[] | IDataObject;

	const agents = Array.isArray(response) ? response : ((response as IDataObject)?.payload as IDataObject[]) || [];
	const options: INodePropertyOptions[] = [{ name: '— Desatribuir —', value: '' }];
	agents.forEach((a) => {
		options.push({
			name: `${a.name ?? a.email ?? a.id} (${a.role ?? 'agent'})`,
			value: String(a.id ?? ''),
		});
	});
	return options;
}

// loadOptions: lista teams da conta pra dropdown de assign.
async function getTeams(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const credentials = await resolveChatwootCredentials.call(this);
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'chatwootApi', {
		method: 'GET',
		url: `${credentials.baseUrl}/api/v1/accounts/${credentials.accountId}/teams`,
		json: true,
	})) as IDataObject[] | IDataObject;

	const teams = Array.isArray(response) ? response : ((response as IDataObject)?.payload as IDataObject[]) || [];
	const options: INodePropertyOptions[] = [{ name: '— Desatribuir —', value: '' }];
	teams.forEach((t) => {
		options.push({ name: String(t.name ?? t.id), value: String(t.id ?? '') });
	});
	return options;
}

// Cache de lifecycle stages por token+account (id → {title, emoji, color}).
// Usado tanto pelo loadOptions (dropdown) quanto pelo postReceive (enriquecer contact).
const __lifecycleStagesCache = new Map<string, Map<number, IDataObject>>();

async function fetchLifecycleStagesMap(
	this: ILoadOptionsFunctions | IExecuteSingleFunctions,
	baseUrl: string,
	accountId: string,
	apiAccessToken: string,
): Promise<Map<number, IDataObject>> {
	const cacheKey = `${apiAccessToken}:${accountId}`;
	const cached = __lifecycleStagesCache.get(cacheKey);
	if (cached) return cached;

	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'chatwootApi', {
		method: 'GET',
		url: `${baseUrl}/api/v1/accounts/${accountId}/lifecycle_stages`,
		json: true,
	})) as IDataObject;

	const stages =
		(response?.payload as IDataObject[]) ||
		(Array.isArray(response) ? (response as unknown as IDataObject[]) : []);

	const map = new Map<number, IDataObject>();
	stages.forEach((s) => {
		const id = Number(s.id);
		if (!Number.isNaN(id)) map.set(id, s);
	});
	__lifecycleStagesCache.set(cacheKey, map);
	return map;
}

// loadOptions: lista lifecycle stages (chatwoot-x) pra dropdown.
async function getLifecycleStages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const credentials = await resolveChatwootCredentials.call(this);
	try {
		const map = await fetchLifecycleStagesMap.call(
			this,
			credentials.baseUrl,
			credentials.accountId,
			credentials.apiAccessToken,
		);

		const options: INodePropertyOptions[] = [{ name: '— Remover estágio —', value: '' }];
		[...map.values()]
			.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
			.forEach((s) => {
				const emoji = s.emoji ? `${s.emoji} ` : '';
				const title = String(s.title ?? s.name ?? `Stage ${s.id}`);
				options.push({ name: `${emoji}${title}`, value: String(s.id ?? '') });
			});
		return options;
	} catch (e) {
		return [{ name: 'Erro ao buscar lifecycle_stages', value: '' }];
	}
}

// postReceive: enriquece response do Contact com lifecycle_stage (objeto com
// title/emoji/color resolvidos do cache). Quando o response retorna só
// lifecycle_stage_id (número), o usuário ainda vê o nome legível.
async function enrichContactWithLifecycleStage(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	_response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (!items.length) return items;

	const credentials = await resolveChatwootCredentials.call(this);
	let stagesMap: Map<number, IDataObject>;
	try {
		stagesMap = await fetchLifecycleStagesMap.call(
			this,
			credentials.baseUrl,
			credentials.accountId,
			credentials.apiAccessToken,
		);
	} catch {
		return items;
	}

	const enrichOne = (contact: IDataObject): IDataObject => {
		const sid = Number(contact.lifecycle_stage_id);
		if (!Number.isNaN(sid) && stagesMap.has(sid)) {
			const stage = stagesMap.get(sid)!;
			const emoji = stage.emoji ? `${stage.emoji} ` : '';
			const title = String(stage.title ?? `Stage ${stage.id}`);
			contact.lifecycle_stage_title = `${emoji}${title}`;
		} else {
			contact.lifecycle_stage_title = null;
		}
		return contact;
	};

	return items.map((item) => {
		const data = item.json as IDataObject;
		if (Array.isArray(data?.payload)) {
			data.payload = (data.payload as IDataObject[]).map((c) => enrichOne(c));
		} else if (data?.id) {
			enrichOne(data);
		}
		return { ...item, json: data };
	});
}

// Factory: gera preSend que resolve Contact ID via identifier + monta URL final.
// Parametrizado em `typeParam`/`valueParam` pra suportar tanto o bloco contact
// (createOrUpdateXxx) quanto contactLabel (contactLabelXxx).
function buildContactByIdentifierPreSend(
	pathSuffix: string,
	methodOverride?: IHttpRequestMethods,
	typeParam = 'createOrUpdateIdentifierType',
	valueParam = 'createOrUpdateIdentifier',
): (this: IExecuteSingleFunctions, requestOptions: IHttpRequestOptions) => Promise<IHttpRequestOptions> {
	return async function (this, requestOptions) {
		const credentials = await resolveChatwootCredentials.call(this);
		const { baseUrl, accountId } = credentials;

		const identifierType = this.getNodeParameter(typeParam) as 'phone_number' | 'identifier';
		const identifierValue = (this.getNodeParameter(valueParam) as string)?.trim();
		if (!identifierValue) {
			throw new Error('Contact Identifier não pode ser vazio.');
		}

		const existing = await searchContactByIdentifier.call(
			this,
			baseUrl,
			accountId,
			identifierType,
			identifierValue,
		);
		if (!existing) {
			throw new Error(
				`Contato não encontrado com ${identifierType}="${identifierValue}". Verifique formato E.164 (+5511...) ou identifier custom.`,
			);
		}

		requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/contacts/${existing.id}${pathSuffix}`;
		if (methodOverride) requestOptions.method = methodOverride;
		return requestOptions;
	};
}

// preSend Add Labels (APPEND): preserva tags existentes + adiciona as novas.
async function addLabelsToContactPreSend(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const credentials = await resolveChatwootCredentials.call(this);
	const { baseUrl, accountId } = credentials;

	const identifierType = this.getNodeParameter('contactLabelIdentifierType') as
		| 'phone_number'
		| 'identifier';
	const identifierValue = (this.getNodeParameter('contactLabelIdentifier') as string)?.trim();
	if (!identifierValue) throw new Error('Contact Identifier não pode ser vazio.');

	const existing = await searchContactByIdentifier.call(
		this,
		baseUrl,
		accountId,
		identifierType,
		identifierValue,
	);
	if (!existing) throw new Error(`Contato não encontrado com ${identifierType}="${identifierValue}".`);

	const labelsToAdd = (this.getNodeParameter('contactLabels', []) as string[]) || [];
	if (!labelsToAdd.length) throw new Error('Selecione ao menos uma label pra adicionar.');

	let currentLabels: string[] = [];
	try {
		const currentResp = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'chatwootApi',
			{
				method: 'GET',
				url: `${baseUrl}/api/v1/accounts/${accountId}/contacts/${existing.id}/labels`,
				json: true,
			},
		)) as IDataObject;
		currentLabels = (currentResp?.payload as string[]) || [];
	} catch {
		currentLabels = [];
	}

	const finalLabels = Array.from(new Set([...currentLabels, ...labelsToAdd]));
	requestOptions.method = 'POST';
	requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/contacts/${existing.id}/labels`;
	requestOptions.body = { labels: finalLabels };
	return requestOptions;
}

// preSend Remove Labels: preserva não-selecionadas + remove as selecionadas.
async function removeLabelsFromContactPreSend(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const credentials = await resolveChatwootCredentials.call(this);
	const { baseUrl, accountId } = credentials;

	const identifierType = this.getNodeParameter('contactLabelIdentifierType') as
		| 'phone_number'
		| 'identifier';
	const identifierValue = (this.getNodeParameter('contactLabelIdentifier') as string)?.trim();
	if (!identifierValue) throw new Error('Contact Identifier não pode ser vazio.');

	const existing = await searchContactByIdentifier.call(
		this,
		baseUrl,
		accountId,
		identifierType,
		identifierValue,
	);
	if (!existing) throw new Error(`Contato não encontrado com ${identifierType}="${identifierValue}".`);

	const labelsToRemove = (this.getNodeParameter('contactLabels', []) as string[]) || [];
	if (!labelsToRemove.length) throw new Error('Selecione ao menos uma label pra remover.');

	let currentLabels: string[] = [];
	try {
		const currentResp = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'chatwootApi',
			{
				method: 'GET',
				url: `${baseUrl}/api/v1/accounts/${accountId}/contacts/${existing.id}/labels`,
				json: true,
			},
		)) as IDataObject;
		currentLabels = (currentResp?.payload as string[]) || [];
	} catch {
		currentLabels = [];
	}

	const removeSet = new Set(labelsToRemove);
	const finalLabels = currentLabels.filter((l) => !removeSet.has(l));
	requestOptions.method = 'POST';
	requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/contacts/${existing.id}/labels`;
	requestOptions.body = { labels: finalLabels };
	return requestOptions;
}

// preSends gerados via factory pra operations que precisam de Contact ID resolvido.
const getContactByIdentifierPreSend = buildContactByIdentifierPreSend('', 'GET');
const deleteContactByIdentifierPreSend = buildContactByIdentifierPreSend('', 'DELETE');
const listLabelsByIdentifierPreSend = buildContactByIdentifierPreSend(
	'/labels',
	'GET',
	'contactLabelIdentifierType',
	'contactLabelIdentifier',
);

// ──────────────────────────────────────────────────────────────────────
//   Helper: Resolver Conversation a partir do Contact Identifier
//   (Respond.io-style — o usuário não precisa saber conversation_id)
// ──────────────────────────────────────────────────────────────────────

// Busca contato + retorna a conversa MAIS RECENTE dele. Joga erro se contato
// não existe ou se ainda não tem nenhuma conversa.
async function findLatestConversationByContactIdentifier(
	this: IExecuteSingleFunctions,
	baseUrl: string,
	accountId: string,
	identifierType: 'phone_number' | 'identifier',
	identifierValue: string,
): Promise<{ contactId: number; conversationId: number }> {
	const contact = await searchContactByIdentifier.call(
		this,
		baseUrl,
		accountId,
		identifierType,
		identifierValue,
	);
	if (!contact) {
		throw new Error(
			`Contato não encontrado com ${identifierType}="${identifierValue}". Verifique formato E.164 (+5511...) ou identifier custom.`,
		);
	}
	const contactId = contact.id as number;

	const convsResp = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'chatwootApi',
		{
			method: 'GET',
			url: `${baseUrl}/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`,
			json: true,
		},
	)) as IDataObject;

	const payload =
		(convsResp?.payload as IDataObject[]) || (convsResp?.data as { payload?: IDataObject[] })?.payload || [];
	if (!payload.length) {
		throw new Error(
			`Contato ${contactId} (${identifierValue}) ainda não tem conversas. Aguarde a primeira mensagem chegar ou crie uma manualmente.`,
		);
	}

	// Ordena por last_activity_at desc (mais recente primeiro). Fallback created_at.
	const sorted = [...payload].sort((a, b) => {
		const aTs = ((a.last_activity_at as number) || (a.created_at as number) || 0) as number;
		const bTs = ((b.last_activity_at as number) || (b.created_at as number) || 0) as number;
		return bTs - aTs;
	});

	return { contactId, conversationId: sorted[0].id as number };
}

// Factory: gera preSend que resolve Conversation ID via Contact Identifier
// + monta URL final pra endpoint de conversation/{id}{pathSuffix}.
function buildConversationByIdentifierPreSend(
	pathSuffix: string,
	methodOverride?: IHttpRequestMethods,
	typeParam = 'identifierType',
	valueParam = 'identifier',
): (this: IExecuteSingleFunctions, requestOptions: IHttpRequestOptions) => Promise<IHttpRequestOptions> {
	return async function (this, requestOptions) {
		const credentials = await resolveChatwootCredentials.call(this);
		const { baseUrl, accountId } = credentials;

		const identifierType = this.getNodeParameter(typeParam) as 'phone_number' | 'identifier';
		const identifierValue = (this.getNodeParameter(valueParam) as string)?.trim();
		if (!identifierValue) {
			throw new Error('Identificador do contato não pode ser vazio.');
		}

		const { conversationId } = await findLatestConversationByContactIdentifier.call(
			this,
			baseUrl,
			accountId,
			identifierType,
			identifierValue,
		);

		requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}${pathSuffix}`;
		if (methodOverride) requestOptions.method = methodOverride;
		return requestOptions;
	};
}

// preSends gerados via factory pra cada operation que precisa de Conversation ID.
const messageCreatePreSend = buildConversationByIdentifierPreSend('/messages', 'POST');
const messageListPreSend = buildConversationByIdentifierPreSend('/messages', 'GET');
const conversationGetPreSend = buildConversationByIdentifierPreSend('', 'GET');
const conversationToggleStatusPreSend = buildConversationByIdentifierPreSend('/toggle_status', 'POST');
const conversationAssignmentPreSend = buildConversationByIdentifierPreSend('/assignments', 'POST');

// preSend Lifecycle Stage (Update / Remove): faz PATCH no contato setando lifecycle_stage_id.
async function lifecycleUpdateContactPreSend(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const credentials = await resolveChatwootCredentials.call(this);
	const { baseUrl, accountId } = credentials;

	const identifierType = this.getNodeParameter('identifierType') as 'phone_number' | 'identifier';
	const identifierValue = (this.getNodeParameter('identifier') as string)?.trim();
	if (!identifierValue) throw new Error('Identificador do contato não pode ser vazio.');

	const contact = await searchContactByIdentifier.call(this, baseUrl, accountId, identifierType, identifierValue);
	if (!contact) throw new Error(`Contato não encontrado com ${identifierType}="${identifierValue}".`);

	const operation = this.getNodeParameter('operation') as string;
	const stageId = operation === 'removeContactStage'
		? null
		: (this.getNodeParameter('lifecycleStageId') as string);

	requestOptions.method = 'PATCH';
	requestOptions.url = `${baseUrl}/api/v1/accounts/${accountId}/contacts/${contact.id}`;
	requestOptions.body = { lifecycle_stage_id: stageId === '' ? null : stageId };
	return requestOptions;
}

/**
 * Chatwoot community node.
 *
 * Covers the full Application API (~112 endpoints across 22 resources) plus
 * chatwoot-x exclusive resources (Lifecycle Stages, Flows, Flow Folders,
 * Flow Runs) that only exist in the x1strategyltda-art/chatwoot-x fork.
 *
 * Authentication: API access token (header `api_access_token`) — see
 * ChatwootApi credential.
 *
 * Built for x1strategyltda / Pedro Lucas. MIT.
 */
export class Chatwoot implements INodeType {
	// Methods registry — usado pelo n8n pra carregar dropdowns dinâmicos (Labels)
	// e pelo resourceMapper (Custom Attributes).
	methods = {
		loadOptions: {
			getLabels: getLabelsForContact,
			getAgents,
			getTeams,
			getLifecycleStages,
		},
		resourceMapping: {
			getCustomAttributesForContact: getCustomAttributesForContactMapper,
		},
	};

	description: INodeTypeDescription = {
		displayName: 'ChatBot',
		name: 'chatwoot',
		icon: 'file:chatwoot.png' as Icon,
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Integração nativa com o ChatBot (app.chatbotx1.com) — contatos, conversas, mensagens, etiquetas, fluxos, etapas do ciclo de vida.',
		defaults: { name: 'ChatBot' },
		usableAsTool: true,
		inputs: ['main' as NodeConnectionType],
		outputs: ['main' as NodeConnectionType],
		credentials: [{ name: 'chatwootApi', required: true }],
		requestDefaults: {
			baseURL: '={{$credentials.baseUrl}}',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		},
		properties: [
			// ─────────────────────── RESOURCE ───────────────────────
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Contact', value: 'contact' },
					{ name: 'Contact Field', value: 'customAttribute' },
					{ name: 'Contact Tag', value: 'contactLabel' },
					{ name: 'Conversation', value: 'conversation' },
					{ name: 'Conversation Assignment', value: 'conversationAssignment' },
					{ name: 'Lifecycle Stage (ChatBot)', value: 'lifecycleStage' },
					{ name: 'Message', value: 'message' },
					{ name: 'Tag', value: 'label' },
				],
				default: 'contact',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                            ACCOUNT
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get the current account',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update the current account',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}' } },
					},
				],
				default: 'get',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['account'], operation: ['update'] } },
				options: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '', routing: { send: { type: 'body', property: 'name' } } },
					{ displayName: 'Locale', name: 'locale', type: 'string', default: '', routing: { send: { type: 'body', property: 'locale' } } },
					{ displayName: 'Domain', name: 'domain', type: 'string', default: '', routing: { send: { type: 'body', property: 'domain' } } },
					{ displayName: 'Support Email', name: 'support_email', type: 'string', default: '', routing: { send: { type: 'body', property: 'support_email' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                          ACCOUNT AGENT BOT
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['accountAgentBot'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List agent bots',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/agent_bots' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create an agent bot',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/agent_bots' } },
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get an agent bot',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/agent_bots/{{$parameter["agentBotId"]}}' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update an agent bot',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/agent_bots/{{$parameter["agentBotId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete an agent bot',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/agent_bots/{{$parameter["agentBotId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Agent Bot ID',
				name: 'agentBotId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['accountAgentBot'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['accountAgentBot'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'name' } },
			},
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['accountAgentBot'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'description' } },
			},
			{
				displayName: 'Outgoing URL',
				name: 'outgoing_url',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['accountAgentBot'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'outgoing_url' } },
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['accountAgentBot'], operation: ['update'] } },
				options: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '', routing: { send: { type: 'body', property: 'name' } } },
					{ displayName: 'Description', name: 'description', type: 'string', default: '', routing: { send: { type: 'body', property: 'description' } } },
					{ displayName: 'Outgoing URL', name: 'outgoing_url', type: 'string', default: '', routing: { send: { type: 'body', property: 'outgoing_url' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                              AGENT
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['agent'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List agents',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/agents' } },
					},
				],
				default: 'list',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                            AUDIT LOG
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['auditLog'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List audit logs',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/audit_logs' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Page',
				name: 'page',
				type: 'number',
				default: 1,
				displayOptions: { show: { resource: ['auditLog'], operation: ['list'] } },
				routing: { send: { type: 'query', property: 'page' } },
			},

			// ═══════════════════════════════════════════════════════════════════
			//                         AUTOMATION RULE
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['automationRule'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List automation rules',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/automation_rules' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create an automation rule',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/automation_rules' } },
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get an automation rule',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/automation_rules/{{$parameter["automationRuleId"]}}' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update an automation rule',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/automation_rules/{{$parameter["automationRuleId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete an automation rule',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/automation_rules/{{$parameter["automationRuleId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Automation Rule ID',
				name: 'automationRuleId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['automationRule'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Body (JSON)',
				name: 'body',
				type: 'json',
				default: '{\n  "name": "",\n  "description": "",\n  "event_name": "conversation_created",\n  "conditions": [],\n  "actions": []\n}',
				displayOptions: { show: { resource: ['automationRule'], operation: ['create', 'update'] } },
				routing: { send: { type: 'body' } },
				description: 'Payload completo da regra de automação. Ver docs Chatwoot.',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                         CANNED RESPONSE
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['cannedResponse'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List canned responses',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/canned_responses' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a canned response',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/canned_responses' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a canned response',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/canned_responses/{{$parameter["cannedResponseId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a canned response',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/canned_responses/{{$parameter["cannedResponseId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Canned Response ID',
				name: 'cannedResponseId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['cannedResponse'], operation: ['update', 'delete'] } },
			},
			{
				displayName: 'Short Code',
				name: 'short_code',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['cannedResponse'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'short_code' } },
			},
			{
				displayName: 'Content',
				name: 'content',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['cannedResponse'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'content' } },
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['cannedResponse'], operation: ['update'] } },
				options: [
					{ displayName: 'Short Code', name: 'short_code', type: 'string', default: '', routing: { send: { type: 'body', property: 'short_code' } } },
					{ displayName: 'Content', name: 'content', type: 'string', default: '', routing: { send: { type: 'body', property: 'content' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                            CONTACT
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['contact'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List contacts',
						routing: {
							request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							output: { postReceive: [enrichContactWithLifecycleStage] },
						},
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a contact',
						routing: {
							request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							output: { postReceive: [enrichContactWithLifecycleStage] },
						},
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a contact',
						// preSend resolve Contact ID via identifier (com fallback BR).
						routing: {
							request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							send: { preSend: [getContactByIdentifierPreSend] },
							output: { postReceive: [createOrUpdateContactPostReceive, enrichContactWithLifecycleStage] },
						},
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a contact',
						// preSend faz search por identifier (com fallback BR) → PUT no ID.
						// Joga erro se não achar contato — diferente do createOrUpdate.
						routing: {
							request: {
								method: 'PUT',
								url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts',
							},
							send: {
								preSend: [updateContactPreSend],
							},
							output: {
								postReceive: [createOrUpdateContactPostReceive, enrichContactWithLifecycleStage],
							},
						},
					},
					{
						name: 'Create or Update',
						value: 'createOrUpdate',
						action: 'Create or update a contact',
						// preSend faz search por identifier (com fallback BR) + decide method (POST/PUT).
						// URL/method aqui são dummy — sobrescritos pelo preSend.
						routing: {
							request: {
								method: 'POST',
								url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts',
							},
							send: {
								preSend: [createOrUpdateContactPreSend],
							},
							output: {
								postReceive: [createOrUpdateContactPostReceive, enrichContactWithLifecycleStage],
							},
						},
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a contact',
						routing: {
							request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							send: { preSend: [deleteContactByIdentifierPreSend] },
						},
					},
					{
						name: 'Search',
						value: 'search',
						action: 'Search contacts',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts/search' } },
					},
				],
				default: 'list',
			},
			// (Contact ID input removido — todas as operations agora usam Identifier Type
			// + Contact Identifier herdado das properties do createOrUpdate.)
			{
				displayName: 'Page',
				name: 'page',
				type: 'number',
				default: 1,
				displayOptions: { show: { resource: ['contact'], operation: ['list', 'search'] } },
				routing: { send: { type: 'query', property: 'page' } },
			},
			{
				displayName: 'Query',
				name: 'q',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['contact'], operation: ['search'] } },
				routing: { send: { type: 'query', property: 'q' } },
				description: 'Texto a buscar em name, identifier, email, phone_number',
			},
			{
				displayName: 'Sort',
				name: 'sort',
				type: 'options',
				default: 'name',
				options: [
					{ name: 'Name (Asc)', value: 'name' },
					{ name: 'Name (Desc)', value: '-name' },
					{ name: 'Created At (Asc)', value: 'created_at' },
					{ name: 'Created At (Desc)', value: '-created_at' },
					{ name: 'Last Activity (Asc)', value: 'last_activity_at' },
					{ name: 'Last Activity (Desc)', value: '-last_activity_at' },
				],
				displayOptions: { show: { resource: ['contact'], operation: ['list', 'search'] } },
				routing: { send: { type: 'query', property: 'sort' } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['contact'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'name' } },
			},
			{
				displayName: 'Create Fields',
				name: 'createFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['contact'], operation: ['create'] } },
				options: [
					{ displayName: 'Email', name: 'email', type: 'string', placeholder: 'name@email.com', default: '', routing: { send: { type: 'body', property: 'email' } } },
					{ displayName: 'Phone Number (E.164)', name: 'phone_number', type: 'string', default: '', placeholder: '+5511999999999', routing: { send: { type: 'body', property: 'phone_number' } } },
					{ displayName: 'Identifier', name: 'identifier', type: 'string', default: '', routing: { send: { type: 'body', property: 'identifier' } } },
					{ displayName: 'Avatar URL', name: 'avatar_url', type: 'string', default: '', routing: { send: { type: 'body', property: 'avatar_url' } } },
					{ displayName: 'Custom Attributes (JSON)', name: 'custom_attributes', type: 'json', default: '{}', routing: { send: { type: 'body', property: 'custom_attributes' } } },
					{ displayName: 'Additional Attributes (JSON)', name: 'additional_attributes', type: 'json', default: '{}', routing: { send: { type: 'body', property: 'additional_attributes' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                CREATE OR UPDATE — Respond.io-style
			//   Operation híbrida: search por phone/identifier, então
			//   POST (create) ou PUT (update). Values to Send carrega os
			//   custom attributes do account via resourceMapper (lista de
			//   campos individuais com refresh + "Fields are outdated").
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Identifier Type',
				name: 'createOrUpdateIdentifierType',
				type: 'options',
				default: 'phone_number',
				required: true,
				displayOptions: { show: { resource: ['contact'], operation: ['createOrUpdate', 'update', 'get', 'delete', 'listConversations', 'listContactableInboxes', 'createContactInbox'] } },
				options: [
					{ name: 'Phone (E.164)', value: 'phone_number' },
					{ name: 'Identifier (Custom ID)', value: 'identifier' },
				],
				description:
					'Qual campo do contato usar pra procurar duplicata: Phone E.164 (+5511999999999) ou Identifier (ID interno do seu sistema, ex: ID do cliente na PayLog)',
			},
			{
				displayName: 'Contact Identifier',
				name: 'createOrUpdateIdentifier',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['contact'], operation: ['createOrUpdate', 'update', 'get', 'delete', 'listConversations', 'listContactableInboxes', 'createContactInbox'] } },
				placeholder: '+5511999999999 ou ID-cliente-123',
				description: 'Valor do identificador escolhido acima',
			},
			{
				displayName: "Contact's First Name",
				name: 'createOrUpdateFirstName',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['contact'], operation: ['createOrUpdate', 'update'] } },
			},
			{
				displayName: "Contact's Last Name",
				name: 'createOrUpdateLastName',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['contact'], operation: ['createOrUpdate', 'update'] } },
			},
			{
				displayName: "Contact's Email",
				name: 'createOrUpdateEmail',
				type: 'string',
				default: '',
				placeholder: 'name@email.com',
				displayOptions: { show: { resource: ['contact'], operation: ['createOrUpdate', 'update'] } },
			},
			{
				displayName: "Contact's Phone Number (E.164)",
				name: 'createOrUpdatePhoneNumber',
				type: 'string',
				default: '',
				placeholder: '+5511999999999',
				displayOptions: { show: { resource: ['contact'], operation: ['createOrUpdate', 'update'] } },
				description:
					'Phone number do contato (independente do identifier). Se o identifier acima for Phone, esse campo é opcional — usaremos o identifier.',
			},
			{
				displayName: 'Values to Send',
				name: 'createOrUpdateValuesToSend',
				type: 'resourceMapper',
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				required: false,
				displayOptions: { show: { resource: ['contact'], operation: ['createOrUpdate', 'update'] } },
				typeOptions: {
					resourceMapper: {
						resourceMapperMethod: 'getCustomAttributesForContact',
						mode: 'add',
						fieldWords: { singular: 'field', plural: 'fields' },
						addAllFields: false,
						multiKeyMatch: false,
					},
				},
				description:
					'Custom attributes do contato. Carrega automaticamente os campos definidos na sua conta Chatwoot. Refresh quando adicionar novos.',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                    CONTACT LABEL — Respond.io-style
			//   List: lista labels do contato.
			//   Add: APPEND (preserva existentes + adiciona selecionadas).
			//   Remove: REMOVE (preserva não-selecionadas + remove selecionadas).
			//   Todas usam Identifier (Phone/Identifier) com fallback BR + dropdown
			//   dinâmico de labels carregado da API.
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['contactLabel'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List tags of a contact',
						routing: {
							request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							send: { preSend: [listLabelsByIdentifierPreSend] },
						},
					},
					{
						name: 'Add',
						value: 'add',
						action: 'Add tags to a contact',
						routing: {
							request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							send: { preSend: [addLabelsToContactPreSend] },
						},
					},
					{
						name: 'Remove',
						value: 'remove',
						action: 'Remove tags from a contact',
						routing: {
							request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							send: { preSend: [removeLabelsFromContactPreSend] },
						},
					},
				],
				default: 'list',
			},
			{
				displayName: 'Identifier Type',
				name: 'contactLabelIdentifierType',
				type: 'options',
				default: 'phone_number',
				required: true,
				displayOptions: { show: { resource: ['contactLabel'] } },
				options: [
					{ name: 'Phone (E.164)', value: 'phone_number' },
					{ name: 'Identifier (Custom ID)', value: 'identifier' },
				],
				description:
					'Qual campo do contato usar pra procurar: Phone E.164 (+5511999999999) ou Identifier (ID custom)',
			},
			{
				displayName: 'Contact Identifier',
				name: 'contactLabelIdentifier',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['contactLabel'] } },
				placeholder: '+5511999999999 ou ID-cliente-123',
				description: 'Valor do identificador escolhido acima',
			},
			{
				displayName: 'Tags',
				name: 'contactLabels',
				type: 'multiOptions',
				default: [],
				required: true,
				displayOptions: { show: { resource: ['contactLabel'], operation: ['add', 'remove'] } },
				typeOptions: {
					loadOptionsMethod: 'getLabels',
				},
				description:
					'Selecione as tags. Refresh manual via 3-pontinhos da lista pra recarregar quando adicionar novas no ChatBot.',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                          CONVERSATION
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['conversation'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get a contact conversation',
						routing: {
							request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/conversations' },
							send: { preSend: [conversationGetPreSend] },
						},
					},
					{
						name: 'Open or Close',
						value: 'toggleStatus',
						action: 'Open or close a contact conversation',
						routing: {
							request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/conversations' },
							send: { preSend: [conversationToggleStatusPreSend] },
						},
					},
					{
						name: 'List',
						value: 'list',
						action: 'List all conversations (with filters)',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/conversations' } },
					},
				],
				default: 'get',
			},
			{
				displayName: 'Tipo de Identificador',
				name: 'identifierType',
				type: 'options',
				default: 'phone_number',
				options: [
					{ name: 'Telefone (E.164)', value: 'phone_number' },
					{ name: 'Identifier (Custom ID)', value: 'identifier' },
				],
				required: true,
				displayOptions: { show: { resource: ['conversation'], operation: ['get', 'toggleStatus'] } },
			},
			{
				displayName: 'Identificador do Contato',
				name: 'identifier',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+5511999999999 ou ID-cliente-123',
				displayOptions: { show: { resource: ['conversation'], operation: ['get', 'toggleStatus'] } },
				description: 'O node pega a conversa MAIS RECENTE desse contato',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'resolved',
				options: [
					{ name: 'Resolvida (Fechar)', value: 'resolved' },
					{ name: 'Aberta', value: 'open' },
					{ name: 'Pendente', value: 'pending' },
					{ name: 'Adiada (Snoozed)', value: 'snoozed' },
				],
				displayOptions: { show: { resource: ['conversation'], operation: ['toggleStatus'] } },
				routing: { send: { type: 'body', property: 'status' } },
			},
			{
				displayName: 'Adiar Até (Snoozed Until)',
				name: 'snoozed_until',
				type: 'string',
				default: '',
				placeholder: '2026-12-31T18:00:00Z',
				displayOptions: { show: { resource: ['conversation'], operation: ['toggleStatus'], status: ['snoozed'] } },
				routing: { send: { type: 'body', property: 'snoozed_until' } },
			},
			{
				displayName: 'Filtros',
				name: 'listFilters',
				type: 'collection',
				placeholder: 'Adicionar filtro',
				default: {},
				displayOptions: { show: { resource: ['conversation'], operation: ['list'] } },
				options: [
					{ displayName: 'Status', name: 'status', type: 'options', default: 'open', options: [{ name: 'Open', value: 'open' }, { name: 'Resolved', value: 'resolved' }, { name: 'Pending', value: 'pending' }, { name: 'Snoozed', value: 'snoozed' }], routing: { send: { type: 'query', property: 'status' } } },
					{ displayName: 'Inbox ID', name: 'inbox_id', type: 'string', default: '', routing: { send: { type: 'query', property: 'inbox_id' } } },
					{ displayName: 'Team ID', name: 'team_id', type: 'string', default: '', routing: { send: { type: 'query', property: 'team_id' } } },
					{ displayName: 'Tags', name: 'labels', type: 'multiOptions', default: [], typeOptions: { loadOptionsMethod: 'getLabels' }, routing: { send: { type: 'query', property: 'labels', value: '={{$value.join(",")}}' } } },
					{ displayName: 'Busca (texto)', name: 'q', type: 'string', default: '', routing: { send: { type: 'query', property: 'q' } } },
					{ displayName: 'Página', name: 'page', type: 'number', default: 1, routing: { send: { type: 'query', property: 'page' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                      CONVERSATION ASSIGNMENT
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['conversationAssignment'] } },
				options: [
					{
						name: 'Assign Agent',
						value: 'assignAgent',
						action: 'Assign or replace the agent of a contact conversation',
						routing: {
							request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/conversations' },
							send: { preSend: [conversationAssignmentPreSend] },
						},
					},
					{
						name: 'Assign Team',
						value: 'assignTeam',
						action: 'Assign or replace the team of a contact conversation',
						routing: {
							request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/conversations' },
							send: { preSend: [conversationAssignmentPreSend] },
						},
					},
				],
				default: 'assignAgent',
			},
			{
				displayName: 'Tipo de Identificador',
				name: 'identifierType',
				type: 'options',
				default: 'phone_number',
				options: [
					{ name: 'Telefone (E.164)', value: 'phone_number' },
					{ name: 'Identifier (Custom ID)', value: 'identifier' },
				],
				required: true,
				displayOptions: { show: { resource: ['conversationAssignment'] } },
			},
			{
				displayName: 'Identificador do Contato',
				name: 'identifier',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+5511999999999 ou ID-cliente-123',
				displayOptions: { show: { resource: ['conversationAssignment'] } },
				description: 'O node pega a conversa MAIS RECENTE do contato',
			},
			{
				displayName: 'Agente',
				name: 'assignee_id',
				type: 'options',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['conversationAssignment'], operation: ['assignAgent'] } },
				typeOptions: { loadOptionsMethod: 'getAgents' },
				routing: { send: { type: 'body', property: 'assignee_id' } },
				description: 'O agente anterior é substituído pelo selecionado',
			},
			{
				displayName: 'Time',
				name: 'team_id',
				type: 'options',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['conversationAssignment'], operation: ['assignTeam'] } },
				typeOptions: { loadOptionsMethod: 'getTeams' },
				routing: { send: { type: 'body', property: 'team_id' } },
				description: 'O time anterior é substituído pelo selecionado',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                        CONTACT FIELD (=Custom Attribute)
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['customAttribute'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List contact fields',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_attribute_definitions' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a contact field',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_attribute_definitions' } },
					},
					{
						name: 'Find',
						value: 'find',
						action: 'Find a contact field by ID',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_attribute_definitions/{{$parameter["customAttributeId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Filtrar por Tipo',
				name: 'attribute_model',
				type: 'options',
				default: 1,
				options: [
					{ name: 'Campos do Contato', value: 1 },
					{ name: 'Campos da Conversa', value: 0 },
				],
				displayOptions: { show: { resource: ['customAttribute'], operation: ['list'] } },
				routing: { send: { type: 'query', property: 'attribute_model' } },
			},
			{
				displayName: 'ID do Campo',
				name: 'customAttributeId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['customAttribute'], operation: ['find'] } },
			},
			{
				displayName: 'Nome do Campo',
				name: 'attribute_display_name',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Preferência de Contato',
				displayOptions: { show: { resource: ['customAttribute'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'attribute_display_name' } },
				description: 'Nome que aparece na UI. Vai virar attribute_key automaticamente (preferencia_de_contato).',
			},
			{
				displayName: 'Tipo de Campo',
				name: 'attribute_display_type',
				type: 'options',
				default: 0,
				required: true,
				options: [
					{ name: 'Texto', value: 0 },
					{ name: 'Número', value: 1 },
					{ name: 'Moeda', value: 2 },
					{ name: 'Porcentagem', value: 3 },
					{ name: 'Link', value: 4 },
					{ name: 'Data', value: 5 },
					{ name: 'Lista (Opções)', value: 6 },
					{ name: 'Sim/Não', value: 7 },
				],
				displayOptions: { show: { resource: ['customAttribute'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'attribute_display_type' } },
			},
			{
				displayName: 'Aplica-se a',
				name: 'attribute_model_create',
				type: 'options',
				default: 1,
				required: true,
				options: [
					{ name: 'Contato', value: 1 },
					{ name: 'Conversa', value: 0 },
				],
				displayOptions: { show: { resource: ['customAttribute'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'attribute_model' } },
			},
			{
				displayName: 'Configurações Avançadas',
				name: 'fieldAdvanced',
				type: 'collection',
				placeholder: 'Adicionar configuração',
				default: {},
				displayOptions: { show: { resource: ['customAttribute'], operation: ['create'] } },
				options: [
					{ displayName: 'Descrição', name: 'attribute_description', type: 'string', default: '', routing: { send: { type: 'body', property: 'attribute_description' } } },
					{ displayName: 'Valores (pra Lista — separados por vírgula)', name: 'attribute_values', type: 'string', default: '', placeholder: 'opção 1, opção 2, opção 3', routing: { send: { type: 'body', property: 'attribute_values', value: '={{$value.split(",").map(s => s.trim()).filter(Boolean)}}' } } },
					{ displayName: 'Chave Customizada (attribute_key)', name: 'attribute_key', type: 'string', default: '', description: 'Deixe vazio pra gerar do nome automaticamente', routing: { send: { type: 'body', property: 'attribute_key' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                         CUSTOM FILTER
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['customFilter'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List custom filters',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_filters' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a custom filter',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_filters' } },
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a custom filter',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_filters/{{$parameter["customFilterId"]}}' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a custom filter',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_filters/{{$parameter["customFilterId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a custom filter',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/custom_filters/{{$parameter["customFilterId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Custom Filter ID',
				name: 'customFilterId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['customFilter'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Body (JSON)',
				name: 'body',
				type: 'json',
				default: '{\n  "name": "",\n  "type": "Conversation",\n  "query": { "payload": [] }\n}',
				displayOptions: { show: { resource: ['customFilter'], operation: ['create', 'update'] } },
				routing: { send: { type: 'body' } },
				description: 'Type: Conversation | Contact | Report. query.payload contém os filtros.',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                       FLOW (chatwoot-x)
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['flow'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List flows',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a flow',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows' } },
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a flow',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows/{{$parameter["flowId"]}}' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a flow',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows/{{$parameter["flowId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a flow',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows/{{$parameter["flowId"]}}' } },
					},
					{
						name: 'Duplicate',
						value: 'duplicate',
						action: 'Duplicate a flow',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows/{{$parameter["flowId"]}}/duplicate' } },
					},
					{
						name: 'Export',
						value: 'export',
						action: 'Export a flow JSON',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows/{{$parameter["flowId"]}}/export' } },
					},
					{
						name: 'Import',
						value: 'import',
						action: 'Import a flow JSON',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/flows/import' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Flow ID',
				name: 'flowId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['flow'], operation: ['get', 'update', 'delete', 'duplicate', 'export'] } },
			},
			{
				displayName: 'Folder ID',
				name: 'folder_id',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['flow'], operation: ['list'] } },
				routing: { send: { type: 'query', property: 'folder_id' } },
				description: 'Filtrar fluxos por pasta. Vazio = todos.',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['flow'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'name' } },
			},
			{
				displayName: 'Create Fields',
				name: 'createFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['flow'], operation: ['create'] } },
				options: [
					{ displayName: 'Folder ID', name: 'folder_id', type: 'string', default: '', routing: { send: { type: 'body', property: 'folder_id' } } },
					{ displayName: 'Trigger Type', name: 'trigger_type', type: 'options', default: 'manual', options: [
						{ name: 'Manual', value: 'manual' },
						{ name: 'Conversation Created', value: 'conversation_created' },
						{ name: 'Conversation Opened', value: 'conversation_opened' },
						{ name: 'Conversation Updated', value: 'conversation_updated' },
						{ name: 'Message Created', value: 'message_created' },
						{ name: 'Message Updated', value: 'message_updated' },
						{ name: 'Contact Created', value: 'contact_created' },
					], routing: { send: { type: 'body', property: 'trigger_type' } } },
				],
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['flow'], operation: ['update'] } },
				options: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '', routing: { send: { type: 'body', property: 'name' } } },
					{ displayName: 'Folder ID', name: 'folder_id', type: 'string', default: '', routing: { send: { type: 'body', property: 'folder_id' } } },
					{ displayName: 'Definition (JSON)', name: 'definition', type: 'json', default: '{}', routing: { send: { type: 'body', property: 'definition' } }, description: 'Estrutura do fluxo (nós + edges)' },
					{ displayName: 'Status', name: 'status', type: 'options', default: 'draft', options: [{ name: 'Draft', value: 'draft' }, { name: 'Published', value: 'published' }], routing: { send: { type: 'body', property: 'status' } } },
				],
			},
			{
				displayName: 'Flow JSON',
				name: 'flowJson',
				type: 'json',
				required: true,
				default: '{}',
				displayOptions: { show: { resource: ['flow'], operation: ['import'] } },
				routing: { send: { type: 'body' } },
				description: 'JSON exportado de outro fluxo chatwoot-x (mesmo schema)',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                    FLOW FOLDER (chatwoot-x)
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['flowFolder'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List flow folders',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/flow_folders' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a flow folder',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/flow_folders' } },
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a flow folder',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/flow_folders/{{$parameter["flowFolderId"]}}' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a flow folder',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/flow_folders/{{$parameter["flowFolderId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a flow folder',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/flow_folders/{{$parameter["flowFolderId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Flow Folder ID',
				name: 'flowFolderId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['flowFolder'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['flowFolder'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'name' } },
			},
			{
				displayName: 'Update Name',
				name: 'name',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['flowFolder'], operation: ['update'] } },
				routing: { send: { type: 'body', property: 'name' } },
			},
			{
				displayName: 'Delete Strategy',
				name: 'delete_strategy',
				type: 'options',
				default: 'move_to_principal',
				options: [
					{ name: 'Move Flows to Root (Principal)', value: 'move_to_principal' },
					{ name: 'Delete All Flows Inside', value: 'delete_all_flows' },
				],
				displayOptions: { show: { resource: ['flowFolder'], operation: ['delete'] } },
				routing: { send: { type: 'query', property: 'delete_strategy' } },
			},

			// ═══════════════════════════════════════════════════════════════════
			//                     FLOW RUN (chatwoot-x)
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['flowRun'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List flow runs',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/flow_runs' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add filter',
				default: {},
				displayOptions: { show: { resource: ['flowRun'], operation: ['list'] } },
				options: [
					{ displayName: 'Flow ID', name: 'flow_id', type: 'string', default: '', routing: { send: { type: 'query', property: 'flow_id' } } },
					{ displayName: 'Conversation ID', name: 'conversation_id', type: 'string', default: '', routing: { send: { type: 'query', property: 'conversation_id' } } },
					{ displayName: 'Status', name: 'status', type: 'options', default: 'completed', options: [{ name: 'Running', value: 'running' }, { name: 'Completed', value: 'completed' }, { name: 'Failed', value: 'failed' }, { name: 'Waiting', value: 'waiting' }], routing: { send: { type: 'query', property: 'status' } } },
					{ displayName: 'Page', name: 'page', type: 'number', default: 1, routing: { send: { type: 'query', property: 'page' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                          HELP CENTER
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['helpCenter'] } },
				options: [
					{
						name: 'List Portals',
						value: 'listPortals',
						action: 'List portals',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/portals' } },
					},
					{
						name: 'Create Portal',
						value: 'createPortal',
						action: 'Create a portal',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/portals' } },
					},
					{
						name: 'Update Portal',
						value: 'updatePortal',
						action: 'Update a portal',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/portals/{{$parameter["portalId"]}}' } },
					},
					{
						name: 'Create Category',
						value: 'createCategory',
						action: 'Create a category in a portal',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/portals/{{$parameter["portalId"]}}/categories' } },
					},
					{
						name: 'Create Article',
						value: 'createArticle',
						action: 'Create an article in a portal',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/portals/{{$parameter["portalId"]}}/articles' } },
					},
				],
				default: 'listPortals',
			},
			{
				displayName: 'Portal ID',
				name: 'portalId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['helpCenter'], operation: ['updatePortal', 'createCategory', 'createArticle'] } },
			},
			{
				displayName: 'Body (JSON)',
				name: 'body',
				type: 'json',
				default: '{}',
				displayOptions: { show: { resource: ['helpCenter'], operation: ['createPortal', 'updatePortal', 'createCategory', 'createArticle'] } },
				routing: { send: { type: 'body' } },
				description: 'Payload completo. Portal: name,slug,color,custom_domain,homepage_link. Category: name,slug,locale,description. Article: title,content,category_id,author_id,status.',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                              INBOX
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['inbox'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List inboxes',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/inboxes' } },
					},
				],
				default: 'list',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                          INBOX MEMBER
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['inboxMember'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List inbox members',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/inbox_members/{{$parameter["inboxId"]}}' } },
					},
					{
						name: 'Add',
						value: 'add',
						action: 'Add inbox members',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/inbox_members' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Replace inbox members',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/inbox_members' } },
					},
					{
						name: 'Remove',
						value: 'remove',
						action: 'Remove inbox members',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/inbox_members' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Inbox ID',
				name: 'inboxId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['inboxMember'] } },
				routing: { send: { type: 'body', property: 'inbox_id', value: '={{$value}}', preSend: [] } },
			},
			{
				displayName: 'User IDs',
				name: 'user_ids',
				type: 'string',
				required: true,
				default: '',
				placeholder: '1,2,3',
				displayOptions: { show: { resource: ['inboxMember'], operation: ['add', 'update', 'remove'] } },
				routing: { send: { type: 'body', property: 'user_ids', value: '={{$value.split(",").map(s => Number(s.trim())).filter(Boolean)}}' } },
				description: 'IDs de usuários separados por vírgula. PATCH substitui toda a lista.',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                          INTEGRATION
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['integration'] } },
				options: [
					{
						name: 'List Apps',
						value: 'listApps',
						action: 'List integration apps',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/integrations/apps' } },
					},
					{
						name: 'Create Hook',
						value: 'createHook',
						action: 'Create a hook',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/integrations/hooks' } },
					},
					{
						name: 'Update Hook',
						value: 'updateHook',
						action: 'Update a hook',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/integrations/hooks/{{$parameter["hookId"]}}' } },
					},
					{
						name: 'Delete Hook',
						value: 'deleteHook',
						action: 'Delete a hook',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/integrations/hooks/{{$parameter["hookId"]}}' } },
					},
				],
				default: 'listApps',
			},
			{
				displayName: 'Hook ID',
				name: 'hookId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['integration'], operation: ['updateHook', 'deleteHook'] } },
			},
			{
				displayName: 'Body (JSON)',
				name: 'body',
				type: 'json',
				default: '{\n  "app_id": "",\n  "inbox_id": null,\n  "settings": {}\n}',
				displayOptions: { show: { resource: ['integration'], operation: ['createHook', 'updateHook'] } },
				routing: { send: { type: 'body' } },
				description: 'App_id: slack, dialogflow, dyte, fullcontact, github, webhook, etc',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                             TAG (=Label)
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['label'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List tags',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/labels' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a tag',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/labels' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a tag',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/labels/{{$parameter["labelId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a tag',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/labels/{{$parameter["labelId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Tag',
				name: 'labelId',
				type: 'options',
				default: '',
				required: true,
				typeOptions: { loadOptionsMethod: 'getLabels' },
				displayOptions: { show: { resource: ['label'], operation: ['update', 'delete'] } },
				description: 'Tag a ser atualizada/excluída',
			},
			{
				displayName: 'Nome da Tag',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'vip',
				displayOptions: { show: { resource: ['label'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'title' } },
				description: 'Nome curto, sem espaço. Aparece nos contatos/conversas.',
			},
			{
				displayName: 'Configurações Avançadas',
				name: 'tagAdvanced',
				type: 'collection',
				placeholder: 'Adicionar configuração',
				default: {},
				displayOptions: { show: { resource: ['label'], operation: ['create', 'update'] } },
				options: [
					{ displayName: 'Novo Nome', name: 'title', type: 'string', default: '', displayOptions: { show: { '/operation': ['update'] } }, routing: { send: { type: 'body', property: 'title' } } },
					{ displayName: 'Descrição', name: 'description', type: 'string', default: '', routing: { send: { type: 'body', property: 'description' } } },
					{ displayName: 'Cor', name: 'color', type: 'color', default: '#1F93FF', routing: { send: { type: 'body', property: 'color' } } },
					{ displayName: 'Mostrar na Sidebar', name: 'show_on_sidebar', type: 'boolean', default: true, routing: { send: { type: 'body', property: 'show_on_sidebar' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                    LIFECYCLE STAGE (chatwoot-x)
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['lifecycleStage'] } },
				options: [
					{
						name: 'Update Contact Lifecycle',
						value: 'updateContactStage',
						action: 'Update the lifecycle stage of a contact',
						routing: {
							request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							send: { preSend: [lifecycleUpdateContactPreSend] },
							output: { postReceive: [enrichContactWithLifecycleStage] },
						},
					},
					{
						name: 'Remove Contact Lifecycle',
						value: 'removeContactStage',
						action: 'Remove the lifecycle stage of a contact',
						routing: {
							request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/contacts' },
							send: { preSend: [lifecycleUpdateContactPreSend] },
							output: { postReceive: [enrichContactWithLifecycleStage] },
						},
					},
					{
						name: 'List Stages',
						value: 'list',
						action: 'List lifecycle stage definitions',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/lifecycle_stages' } },
					},
				],
				default: 'updateContactStage',
			},
			{
				displayName: 'Tipo de Identificador',
				name: 'identifierType',
				type: 'options',
				default: 'phone_number',
				options: [
					{ name: 'Telefone (E.164)', value: 'phone_number' },
					{ name: 'Identifier (Custom ID)', value: 'identifier' },
				],
				required: true,
				displayOptions: { show: { resource: ['lifecycleStage'], operation: ['updateContactStage', 'removeContactStage'] } },
			},
			{
				displayName: 'Identificador do Contato',
				name: 'identifier',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+5511999999999 ou ID-cliente-123',
				displayOptions: { show: { resource: ['lifecycleStage'], operation: ['updateContactStage', 'removeContactStage'] } },
			},
			{
				displayName: 'Estágio do Ciclo de Vida',
				name: 'lifecycleStageId',
				type: 'options',
				default: '',
				required: true,
				typeOptions: { loadOptionsMethod: 'getLifecycleStages' },
				displayOptions: { show: { resource: ['lifecycleStage'], operation: ['updateContactStage'] } },
				description: 'Selecione o estágio a aplicar no contato',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                             MESSAGE
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						name: 'Send',
						value: 'create',
						action: 'Send a message to a contact',
						routing: {
							request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/conversations' },
							send: { preSend: [messageCreatePreSend] },
						},
					},
					{
						name: 'List',
						value: 'list',
						action: 'List messages of a contact conversation',
						routing: {
							request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/conversations' },
							send: { preSend: [messageListPreSend] },
						},
					},
				],
				default: 'create',
			},
			{
				displayName: 'Tipo de Identificador',
				name: 'identifierType',
				type: 'options',
				default: 'phone_number',
				options: [
					{ name: 'Telefone (E.164)', value: 'phone_number' },
					{ name: 'Identifier (Custom ID)', value: 'identifier' },
				],
				required: true,
				displayOptions: { show: { resource: ['message'] } },
				description: 'Como você quer identificar o contato. O node busca a conversa mais recente dele.',
			},
			{
				displayName: 'Identificador do Contato',
				name: 'identifier',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+5511999999999 ou ID-cliente-123',
				displayOptions: { show: { resource: ['message'] } },
				description: 'Telefone E.164 (+55...) ou identifier custom do contato',
			},
			{
				displayName: 'Mensagem',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				placeholder: 'Olá! Tudo bem?',
				displayOptions: { show: { resource: ['message'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'content' } },
				description: 'Texto da mensagem que vai pro contato',
			},
			{
				displayName: 'Mensagem Privada (Nota Interna)',
				name: 'private',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['message'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'private' } },
				description: 'Liga pra criar uma nota interna no contato (não é enviada ao cliente, só os agentes veem)',
			},
			{
				displayName: 'Configurações Avançadas',
				name: 'messageAdvanced',
				type: 'collection',
				placeholder: 'Adicionar configuração',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['create'] } },
				options: [
					{
						displayName: 'Tipo da Mensagem',
						name: 'message_type',
						type: 'options',
						default: 'outgoing',
						options: [
							{ name: 'Outgoing (Agente → Contato)', value: 'outgoing' },
							{ name: 'Incoming (Contato → Agente)', value: 'incoming' },
						],
						routing: { send: { type: 'body', property: 'message_type' } },
						description: 'Padrão é Outgoing — só mude se quiser simular mensagem que veio do contato',
					},
					{
						displayName: 'Tipo de Conteúdo',
						name: 'content_type',
						type: 'options',
						default: 'text',
						options: [
							{ name: 'Texto', value: 'text' },
							{ name: 'Input Select (opções clicáveis)', value: 'input_select' },
							{ name: 'Cards', value: 'cards' },
							{ name: 'Form', value: 'form' },
							{ name: 'Article', value: 'article' },
						],
						routing: { send: { type: 'body', property: 'content_type' } },
						description: 'Padrão é Texto — só mude se quiser interativo (input_select, cards, etc)',
					},
					{
						displayName: 'Atributos do Conteúdo (JSON)',
						name: 'content_attributes',
						type: 'json',
						default: '{}',
						routing: { send: { type: 'body', property: 'content_attributes' } },
						description: 'Atributos extras pro tipo de conteúdo (ex: items pra input_select, fields pra form). Deixe vazio pra texto puro.',
					},
					{
						displayName: 'Template WhatsApp (JSON)',
						name: 'template_params',
						type: 'json',
						default: '{}',
						routing: { send: { type: 'body', property: 'template_params' } },
						description: 'Só pra WhatsApp Cloud quando quer disparar template aprovado: { name, category, language, processed_params: { body, header } }',
					},
				],
			},
			{
				displayName: 'Page (Before Message ID)',
				name: 'before',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['message'], operation: ['list'] } },
				routing: { send: { type: 'query', property: 'before' } },
				description: 'Paginação: retorna mensagens mais antigas que esse ID',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                             PROFILE
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['profile'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get the current user profile',
						routing: { request: { method: 'GET', url: '/api/v1/profile' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update the current user profile',
						routing: { request: { method: 'PUT', url: '/api/v1/profile' } },
					},
				],
				default: 'get',
			},
			{
				displayName: 'Profile Update Body (JSON)',
				name: 'profileBody',
				type: 'json',
				default: '{\n  "profile": {\n    "name": "",\n    "email": "",\n    "display_name": "",\n    "avatar": null,\n    "current_password": "",\n    "password": "",\n    "password_confirmation": ""\n  }\n}',
				displayOptions: { show: { resource: ['profile'], operation: ['update'] } },
				routing: { send: { type: 'body' } },
			},

			// ═══════════════════════════════════════════════════════════════════
			//                             REPORT
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['report'] } },
				options: [
					{
						name: 'Account Summary',
						value: 'accountSummary',
						action: 'Get account summary report',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/reports/summary' } },
					},
					{
						name: 'Conversations',
						value: 'conversations',
						action: 'Get conversations report',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/reports/conversations' } },
					},
					{
						name: 'Account Reports (Time Series)',
						value: 'accountReports',
						action: 'Get account reports timeseries',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/reports' } },
					},
					{
						name: 'Channel Summary',
						value: 'channelSummary',
						action: 'Get channel summary report',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/summary_reports/channel' } },
					},
					{
						name: 'Inbox Summary',
						value: 'inboxSummary',
						action: 'Get inbox summary report',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/summary_reports/inbox' } },
					},
					{
						name: 'Agent Summary',
						value: 'agentSummary',
						action: 'Get agent summary report',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/summary_reports/agent' } },
					},
					{
						name: 'Team Summary',
						value: 'teamSummary',
						action: 'Get team summary report',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/summary_reports/team' } },
					},
					{
						name: 'First Response Time Distribution',
						value: 'firstResponseTime',
						action: 'Get first response time distribution',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/reports/first_response_time_distribution' } },
					},
					{
						name: 'Inbox Label Matrix',
						value: 'inboxLabelMatrix',
						action: 'Get inbox tag matrix',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/reports/inbox_label_matrix' } },
					},
					{
						name: 'Outgoing Messages Count',
						value: 'outgoingMessages',
						action: 'Get outgoing messages count',
						routing: { request: { method: 'GET', url: '=/api/v2/accounts/{{$credentials.accountId}}/reports/outgoing_messages_count' } },
					},
					{
						name: 'Reporting Events',
						value: 'reportingEvents',
						action: 'Get account reporting events',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/reporting_events' } },
					},
				],
				default: 'accountSummary',
			},
			{
				displayName: 'Report Filters',
				name: 'reportFilters',
				type: 'collection',
				placeholder: 'Add filter',
				default: {},
				displayOptions: { show: { resource: ['report'] } },
				options: [
					{ displayName: 'Since (Epoch Seconds)', name: 'since', type: 'string', default: '', routing: { send: { type: 'query', property: 'since' } } },
					{ displayName: 'Until (Epoch Seconds)', name: 'until', type: 'string', default: '', routing: { send: { type: 'query', property: 'until' } } },
					{ displayName: 'Type', name: 'type', type: 'options', default: 'account', options: [{ name: 'Account', value: 'account' }, { name: 'Agent', value: 'agent' }, { name: 'Inbox', value: 'inbox' }, { name: 'Label', value: 'label' }, { name: 'Team', value: 'team' }], routing: { send: { type: 'query', property: 'type' } } },
					{ displayName: 'ID', name: 'id', type: 'string', default: '', description: 'ID do recurso (agent/inbox/label/team)', routing: { send: { type: 'query', property: 'id' } } },
					{ displayName: 'Metric', name: 'metric', type: 'options', default: 'conversations_count', options: [
						{ name: 'Conversations Count', value: 'conversations_count' },
						{ name: 'Incoming Messages Count', value: 'incoming_messages_count' },
						{ name: 'Outgoing Messages Count', value: 'outgoing_messages_count' },
						{ name: 'Avg First Response Time', value: 'avg_first_response_time' },
						{ name: 'Avg Resolution Time', value: 'avg_resolution_time' },
						{ name: 'Resolutions Count', value: 'resolutions_count' },
					], routing: { send: { type: 'query', property: 'metric' } } },
					{ displayName: 'Business Hours', name: 'business_hours', type: 'boolean', default: false, routing: { send: { type: 'query', property: 'business_hours' } } },
					{ displayName: 'Group By', name: 'group_by', type: 'options', default: 'day', options: [{ name: 'Day', value: 'day' }, { name: 'Week', value: 'week' }, { name: 'Month', value: 'month' }, { name: 'Year', value: 'year' }], routing: { send: { type: 'query', property: 'group_by' } } },
				],
			},

			// ═══════════════════════════════════════════════════════════════════
			//                              TEAM
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['team'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List teams',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/teams' } },
					},
				],
				default: 'list',
			},

			// ═══════════════════════════════════════════════════════════════════
			//                            WEBHOOK
			// ═══════════════════════════════════════════════════════════════════
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['webhook'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'List webhooks',
						routing: { request: { method: 'GET', url: '=/api/v1/accounts/{{$credentials.accountId}}/webhooks' } },
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a webhook',
						routing: { request: { method: 'POST', url: '=/api/v1/accounts/{{$credentials.accountId}}/webhooks' } },
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a webhook',
						routing: { request: { method: 'PATCH', url: '=/api/v1/accounts/{{$credentials.accountId}}/webhooks/{{$parameter["webhookId"]}}' } },
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a webhook',
						routing: { request: { method: 'DELETE', url: '=/api/v1/accounts/{{$credentials.accountId}}/webhooks/{{$parameter["webhookId"]}}' } },
					},
				],
				default: 'list',
			},
			{
				displayName: 'Webhook ID',
				name: 'webhookId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['webhook'], operation: ['update', 'delete'] } },
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com/webhook',
				displayOptions: { show: { resource: ['webhook'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'url' } },
			},
			{
				displayName: 'Subscriptions',
				name: 'subscriptions',
				type: 'multiOptions',
				default: ['conversation_created', 'message_created'],
				options: [
					{ name: 'Conversation Created', value: 'conversation_created' },
					{ name: 'Conversation Status Changed', value: 'conversation_status_changed' },
					{ name: 'Conversation Updated', value: 'conversation_updated' },
					{ name: 'Message Created', value: 'message_created' },
					{ name: 'Message Updated', value: 'message_updated' },
					{ name: 'Webwidget Triggered', value: 'webwidget_triggered' },
				],
				displayOptions: { show: { resource: ['webhook'], operation: ['create', 'update'] } },
				routing: { send: { type: 'body', property: 'subscriptions' } },
			},
			{
				displayName: 'Update Fields',
				name: 'updateWebhookFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['webhook'], operation: ['update'] } },
				options: [
					{ displayName: 'URL', name: 'url', type: 'string', default: '', routing: { send: { type: 'body', property: 'url' } } },
				],
			},
		],
	};
}
