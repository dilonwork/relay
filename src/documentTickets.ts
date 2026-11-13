// Ticket payloads opened from a Prototype document (design doc
// ch. 17): the single source of truth for the two actions on the
// Documents page — Implement opens an implementation ticket on the
// built-in flow, Not OK opens a re-planning ticket on the Prototype
// flow. The panel (DocumentsPanel.tsx) builds both payloads through
// these functions, and server/documentTickets.test.js requires this
// module directly (type stripping), so the tests exercise the exact
// code the frontend runs.
//
// The module is pure and dependency-free on purpose: no imports, no
// API calls, no window access — the panel owns the fetching and the
// navigation, this module only decides what a ticket says and which
// workflow it follows.

// The Prototype flow is a workflow row in the live database, not a
// seed and not one of the editor's example templates (those are
// fixtures in server/workflowExamples.js): its id is generated when
// an admin builds it in the editor, so no code may hardcode it, and
// the 8-character prefix in a ticket title is not a usable id — the
// server looks a workflow up by its full id. The panel therefore
// resolves the flow by name at submit time, from GET /api/workflows
// (readable by any signed-in account, project-scoped like the ticket
// reads): the flow's name is 'Prototype flow', the same name the
// server tests use for the fixture of that shape.
export const PROTOTYPE_FLOW_NAME = 'Prototype flow';

// The fields the payload builders need from a document. DocumentItem
// (src/api.ts) carries these, so the panel passes it straight in.
export interface PrototypeDocumentRef {
  id: string;
  title: string;
  content: string;
  project_id: string | null;
}

// The fields the flow lookup needs from a workflow. Workflow
// (src/api.ts) carries these, so the panel passes the list straight
// in.
export interface WorkflowRef {
  id: string | null;
  name: string;
  project_id: string | null;
}

export interface TicketPayload {
  title: string;
  description: string;
}

function sourceBlock(doc: PrototypeDocumentRef, projectName: string, origin: string): string {
  return [
    `Source document: ${doc.title} (category: Prototype, document ID: ${doc.id})`,
    `Document page: ${origin}/#/documents`,
    `Project: ${projectName}`,
  ].join('\n');
}

function contentBlock(doc: PrototypeDocumentRef): string {
  return [
    'Document content:',
    doc.content ? doc.content : '(No content)',
  ].join('\n');
}

// The Implement ticket (unchanged since ticket abe5fa10): the title
// names the action, the description carries the document reference
// plus the full content, so the implementer can read the prototype
// from the ticket itself. No workflow is named, so the ticket follows
// the built-in flow, like a ticket created without a workflow from
// the New ticket form.
export function buildImplementTicket(
  doc: PrototypeDocumentRef,
  projectName: string,
  origin: string,
): TicketPayload {
  const description = [
    `Implement the Prototype document "${doc.title}".`,
    '',
    sourceBlock(doc, projectName, origin),
    '',
    contentBlock(doc),
  ].join('\n');
  return {
    title: `Implement Prototype: ${doc.title}`,
    description,
  };
}

// The re-planning ticket opened by Not OK: the title says at a glance
// that this is a re-plan, not an implementation, and the description
// leads with the reviewer's reason, then the same document reference
// and full content as the Implement ticket, so the planner can read
// the prototype and the feedback from the ticket itself. The reason
// is returned separately as well: the panel passes it as the ticket
// creation reason, so it shows in the ticket's history.
export function buildReplanTicket(
  doc: PrototypeDocumentRef,
  reason: string,
  projectName: string,
  origin: string,
): TicketPayload & { reason: string } {
  const cleanReason = reason.trim();
  const description = [
    `The Prototype document "${doc.title}" was reviewed as not OK and needs re-planning.`,
    '',
    'Reason / feedback:',
    cleanReason,
    '',
    sourceBlock(doc, projectName, origin),
    '',
    contentBlock(doc),
  ].join('\n');
  return {
    title: `Re-plan Prototype: ${doc.title}`,
    description,
    reason: cleanReason,
  };
}

// A re-planning reason is required: blank or whitespace-only feedback
// must not open a ticket. The panel disables the submit button while
// the reason is blank and guards the submit handler with this.
export function isValidReplanReason(reason: string): boolean {
  return reason.trim().length > 0;
}

// Find the Prototype flow in a workflow list (GET /api/workflows).
// A project workflow only applies to its own project's tickets, so a
// project-scoped match wins; a global workflow (project_id null)
// applies anywhere and is the fallback. Workflows without an id (the
// built-in default has none) can never be named on ticket creation,
// so they are skipped. Returns null when no Prototype flow exists —
// the panel then reports the missing workflow and opens no ticket,
// instead of opening one on the wrong flow.
export function findPrototypeFlow(
  workflows: WorkflowRef[],
  projectId: string | null,
): WorkflowRef | null {
  const named = workflows.filter(
    (w) => w.name === PROTOTYPE_FLOW_NAME && w.id,
  );
  const scoped = named.find((w) => w.project_id === projectId);
  if (scoped) return scoped;
  return named.find((w) => w.project_id === null) || null;
}
