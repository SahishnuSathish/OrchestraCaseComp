// Old run links (#/runs/:runId/tickets[/:id]) land here only when this tab does not know the inbox run yet.
// The inbox now holds every ticket, so this asks the server for the inbox run and redirects: to #/inbox/<id> when the
// link was for the inbox run, otherwise to Settings, Advanced, where batch runs live (router.runLinkTarget).
import { redirectRunLink } from '../components/workspace/run-link.js';

export function mount(root, { route }) { return redirectRunLink(root, route); }
