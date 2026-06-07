import type {
	IAuthenticateGeneric,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestHelper,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * ChatBot API credential — UI simplificada (paridade Respond.io).
 *
 * O usuário só preenche UM campo: a API Access Token gerada em
 * ChatBot → Configurações → Integrações → n8n → Gerar chave de API.
 *
 * baseUrl e accountId são resolvidos automaticamente:
 *   - baseUrl: hardcoded em `CHATBOT_BASE_URL`
 *   - accountId: descoberto via GET /api/v1/profile no preAuthentication
 *
 * O token gerado pela integração nativa do ChatBot pertence a um User
 * dedicado vinculado a uma única conta, então o accountId é determinístico.
 */
const CHATBOT_BASE_URL = 'https://app.chatbotx1.com';

export class ChatwootApi implements ICredentialType {
	name = 'chatwootApi';

	displayName = 'ChatBot API';

	icon: Icon = 'file:chatwoot.png';

	documentationUrl = 'https://app.chatbotx1.com/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Access Token',
			name: 'apiAccessToken',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Gere em ChatBot → Configurações → Integrações → n8n → Gerar chave de API. Enviada no header api_access_token.',
		},
	];

	/**
	 * Resolve baseUrl + accountId a partir do token. Chamado pelo n8n antes
	 * de cada request autenticado — n8n injeta o resultado nas credentials
	 * do request.
	 *
	 * Routing-style operations usam `{{$credentials.baseUrl}}` e
	 * `{{$credentials.accountId}}` direto — preAuthentication faz com que
	 * esses placeholders resolvam aos valores corretos.
	 */
	async preAuthentication(
		this: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
	) {
		const baseUrl = CHATBOT_BASE_URL;

		const response = (await this.helpers.httpRequest({
			method: 'GET',
			url: `${baseUrl}/api/v1/profile`,
			headers: { api_access_token: credentials.apiAccessToken as string },
			json: true,
		})) as { account_id?: number | string; accounts?: Array<{ id: number | string }> };

		const accountId = String(
			response.account_id ?? response.accounts?.[0]?.id ?? '1',
		);

		return { baseUrl, accountId };
	}

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				api_access_token: '={{$credentials.apiAccessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: CHATBOT_BASE_URL,
			url: '/api/v1/profile',
			method: 'GET',
		},
	};
}
