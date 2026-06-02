# n8n-nodes-chatwoot-x1

Custom **n8n community node** for [Chatwoot](https://www.chatwoot.com) — the open-source omnichannel customer support platform.

Covers the **complete Application API** (~112 endpoints across 22 resources) plus **chatwoot-x exclusive** resources (Lifecycle Stages, Flows, Flow Folders, Flow Runs) — features that exist only in the [x1strategyltda-art/chatwoot-x](https://github.com/x1strategyltda-art/chatwoot-x) fork.

Built by Pedro Lucas (x1strategyltda) for the PayAfter operation.

## Features

| Resource | Operations |
|----------|-----------|
| **Account** | Get, Update |
| **Account AgentBot** | List, Create, Get, Update, Delete |
| **Agent** | List, Add, Update, Remove |
| **Audit Log** | List |
| **Automation Rule** | List, Create, Get, Update, Delete |
| **Canned Response** | List, Create, Update, Delete |
| **Contact** | List, Create, Get, Update, Delete, Search, Filter, List Conversations, List Inboxes, Merge |
| **Contact Label** | List, Add |
| **Conversation** | Meta, List, Create, Filter, Get, Update, Toggle Status, Toggle Priority, Toggle Typing, Set Custom Attributes, Reporting Events |
| **Conversation Assignment** | Assign |
| **Conversation Label** | List, Update |
| **Custom Attribute** | List, Create, Get, Update, Delete |
| **Custom Filter** | List, Create, Get, Update, Delete |
| **Help Center** | Create Portal, List Portals, Update Portal, Create Category, Create Article |
| **Inbox** | List, Create, Get, Update, Get Agent Bot, Set Agent Bot |
| **Inbox Member** | List, Create, Update, Delete |
| **Integration** | List Apps, Create Hook, Update Hook, Delete Hook |
| **Label** | List, Create, Get, Update, Delete |
| **Message** | List, Create, Delete |
| **Profile** | Get, Update |
| **Report** | Account Summary, Conversations, Channel Summary, Inbox Summary, Agent Summary, Team Summary, First Response Time Distribution, Inbox Label Matrix, Outgoing Messages |
| **Team** | List, Create, Get, Update, Delete, List Members, Add Members, Update Members, Remove Members |
| **Webhook** | List, Create, Update, Delete |
| **Lifecycle Stage** ⭐ | List, Create, Get, Update, Delete |
| **Flow** ⭐ | List, Create, Get, Update, Delete, Duplicate, Export, Import |
| **Flow Folder** ⭐ | List, Create, Get, Update, Delete |
| **Flow Run** ⭐ | List |

⭐ = chatwoot-x exclusive (not in upstream Chatwoot).

## Installation

### Via n8n Community Nodes UI (recommended)

1. In Coolify (or your n8n env), ensure `N8N_COMMUNITY_PACKAGES_ENABLED=true`.
2. Restart n8n.
3. In n8n: **Settings → Community Nodes → Install a Community Node**.
4. Paste `n8n-nodes-chatwoot-x1` and click Install.
5. Wait ~30s for restart. The **Chatwoot** node will appear in the palette.

### Manual install (Docker)

```bash
docker exec -it <n8n_container> npm install n8n-nodes-chatwoot-x1
docker restart <n8n_container>
```

## Credential Setup

In n8n: **Credentials → New → Chatwoot API**.

| Field | Value |
|-------|-------|
| **API Access Token** | From Chatwoot → Profile Settings → Access Token |
| **Base URL** | Default: `https://staging.chatwootx1.us`. Change to your Chatwoot instance origin (no trailing slash, no `/api/v1`). |
| **Account ID** | Numeric account ID (visible in the Chatwoot URL, e.g. `/app/accounts/1/...` → `1`) |

The credential test calls `GET /api/v1/profile` to validate the token.

## Authentication

Header `api_access_token: <your_token>` — sent automatically by the credential.

## Example workflow

```
[Webhook PayLog: order_paid]
   ↓
[Chatwoot: Contact → Search] (by phone) → contactId
   ↓
[Chatwoot: Lifecycle Stage → Update Contact] (stage=Cliente)
   ↓
[Chatwoot: Flow → Trigger] (pos-venda)
   ↓
[Chatwoot: Conversation → Toggle Status] (open + assign)
```

## Development

```bash
npm install
npm run build       # compile TS → dist/
npm run dev         # n8n hot-reload locally
npm run lint        # lint code
```

## License

MIT — Pedro Lucas (x1strategyltda).

## Repo & Issues

- Source: https://github.com/x1strategyltda-art/n8n-nodes-chatwoot
- Issues: https://github.com/x1strategyltda-art/n8n-nodes-chatwoot/issues

## Related links

- Chatwoot Application API: https://www.chatwoot.com/developers/api/
- Chatwoot Docs: https://www.chatwoot.com/docs
- chatwoot-x fork: https://github.com/x1strategyltda-art/chatwoot-x
- n8n Community Nodes docs: https://docs.n8n.io/integrations/community-nodes/
