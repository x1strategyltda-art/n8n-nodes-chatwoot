import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Chatwoot API credential (Application API).
 *
 * Authentication: API access token sent via header `api_access_token`.
 *
 * Where to find:
 *   Chatwoot UI → Profile Settings → Access Token
 *
 * Docs: https://www.chatwoot.com/developers/api/
 *
 * The Application API operates on a single account. The numeric Account ID
 * lives in your Chatwoot URL right after `/app/accounts/`. Example:
 *   https://staging.chatwootx1.us/app/accounts/1/conversations  →  accountId = 1
 */
export class ChatwootApi implements ICredentialType {
	name = 'chatwootApi';

	displayName = 'Chatwoot API';

	icon: Icon = 'file:chatwoot.png';

	documentationUrl = 'https://www.chatwoot.com/developers/api/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Access Token',
			name: 'apiAccessToken',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Token gerado no Chatwoot em Profile Settings → Access Token. Enviado no cabeçalho api_access_token.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://staging.chatwootx1.us',
			placeholder: 'https://staging.chatwootx1.us',
			required: true,
			description:
				'Origem da sua instância Chatwoot (sem barra no fim, sem /api/v1). Padrão: staging.chatwootx1.us.',
		},
		{
			displayName: 'Account ID',
			name: 'accountId',
			type: 'string',
			default: '1',
			required: true,
			description:
				'ID numérico da conta (workspace) no Chatwoot. Visível na URL: /app/accounts/<id>/...',
		},
	];

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
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/profile',
			method: 'GET',
		},
	};
}
