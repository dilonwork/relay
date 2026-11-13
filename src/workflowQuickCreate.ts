// Quick create for the workflow editor (design doc ch. 15): turn a
// list of (state label, responsible role) rows into a linear workflow
// definition — states chained in order, first state the start, last
// state terminal. Pure functions, no React and no DOM, so the editor
// (src/WorkflowsPanel.tsx) and the server test runner both use this
// one module; there is no second copy of the chaining logic.
//
// The generated definition satisfies workflows.validateWorkflowDefinition
// as long as it has at least two rows with valid roles: every
// non-terminal state gets one outgoing transition, every state is
// reachable from the start, and the roles map covers exactly the
// states. The first transition is kind 'pickup' (the queue entry
// point, like the example flows); the rest are 'forward'. No backward
// transitions and no reason requirements are generated — those are
// advanced settings the user adds in the editor afterwards.

export interface QuickCreateEntry {
  label: string;
  role: string | null;
}

export interface QuickCreateState {
  code: string;
  label: string;
  sort_order: number;
  is_start: boolean;
  is_terminal: boolean;
}

export interface QuickCreateTransition {
  from: string;
  to: string;
  role: string;
  requiresReason: boolean;
  requiresHandoff: boolean;
  kind: string;
  selfCheck: boolean;
}

export interface QuickCreateRoles {
  [code: string]: { role: string | null; responsibilities: string };
}

export type QuickCreateResult =
  | {
      ok: true;
      states: QuickCreateState[];
      transitions: QuickCreateTransition[];
      roles: QuickCreateRoles;
    }
  | { ok: false; error: string };

const WORKFLOW_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux'];

// Derive a state code from a label. Mirrors helpers.slugStateCode
// (lowercase snake_case); kept inline so this module has no imports
// and stays usable from both the browser bundle and plain node.
function slugStateCode(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function buildLinearFlow(entries: QuickCreateEntry[]): QuickCreateResult {
  const rows = (entries || []).filter(
    (e) => e && typeof e.label === 'string' && e.label.trim()
  );
  if (rows.length < 2) {
    return { ok: false, error: 'Add at least two states to generate a linear flow.' };
  }
  // Codes come from the labels; a label with no usable characters
  // (e.g. all Chinese) falls back to state_N, and collisions get a
  // numeric suffix, so the result always has unique valid codes.
  const used = new Set<string>();
  const states: QuickCreateState[] = rows.map((entry, i) => {
    let code = slugStateCode(entry.label);
    if (!code) code = `state_${i + 1}`;
    let unique = code;
    let n = 2;
    while (used.has(unique)) {
      unique = `${code}_${n}`;
      n++;
    }
    used.add(unique);
    return {
      code: unique,
      label: entry.label.trim(),
      sort_order: i,
      is_start: i === 0,
      is_terminal: i === rows.length - 1,
    };
  });
  for (let i = 0; i < rows.length - 1; i++) {
    if (!WORKFLOW_ROLES.includes(rows[i].role || '')) {
      return { ok: false, error: `State "${rows[i].label.trim()}" needs a role.` };
    }
  }
  const roles: QuickCreateRoles = {};
  states.forEach((s, i) => {
    // The terminal state has no role by server rule; its
    // responsibilities line is fixed. Non-terminal states get the
    // chosen role and a default responsibilities sentence the user
    // can refine in the Roles table.
    roles[s.code] = s.is_terminal
      ? { role: null, responsibilities: 'Terminal state. The work is done; no further action.' }
      : { role: rows[i].role, responsibilities: `Handle the ${s.label} step.` };
  });
  const transitions: QuickCreateTransition[] = [];
  for (let i = 0; i < states.length - 1; i++) {
    transitions.push({
      from: states[i].code,
      to: states[i + 1].code,
      role: rows[i].role as string,
      requiresReason: false,
      requiresHandoff: false,
      kind: i === 0 ? 'pickup' : 'forward',
      selfCheck: false,
    });
  }
  return { ok: true, states, transitions, roles };
}
