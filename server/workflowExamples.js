// Relay example workflows (design doc ch. 15, ticket baebf8b7).
// Dylan's three flows, as the first acceptance examples for the state
// machine editor. These are test fixtures and editor reference data,
// NOT seeds: the flows are built in the editor (or via the API), never
// inserted by a migration. Each definition is a full workflow
// definition: states (code, label, order, start, terminal),
// transitions (from -> to, role, requiresReason, requiresHandoff,
// kind) and the roles map (state -> {role, responsibilities}).
//
// Roles use the seven workflow roles. In these fixtures the transition
// role equals the from-state's role in the roles map; that is the
// normal case (ch. 15: the roles map is the per-state assignment and
// the server re-derives the stored transition roles from it on save).
// 'cancelled' is not listed: it is the universal cancel target and
// needs no state or role entry.

// Flow A: user requirement, with a confirmation step that can send
// the ticket back to planning.
//   User requirement -> Feature planning -> User confirmation -> Generate spec -> Delivered
//   User confirmation rejected -> back to Feature planning (backward, reason required)
const FLOW_WITH_CONFIRMATION = {
  name: 'Spec flow (with confirmation)',
  states: [
    { code: 'user_requirement', label: 'User requirement', sort_order: 0, is_start: true, is_terminal: false },
    { code: 'feature_planning', label: 'Feature planning', sort_order: 1, is_start: false, is_terminal: false },
    { code: 'user_confirmation', label: 'User confirmation', sort_order: 2, is_start: false, is_terminal: false },
    { code: 'spec_generation', label: 'Generate spec', sort_order: 3, is_start: false, is_terminal: false },
    { code: 'delivered', label: 'Delivered', sort_order: 4, is_start: false, is_terminal: true },
  ],
  transitions: [
    { from: 'user_requirement', to: 'feature_planning', role: 'leader', requiresReason: false, requiresHandoff: false, kind: 'pickup', selfCheck: false },
    { from: 'feature_planning', to: 'user_confirmation', role: 'leader', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
    { from: 'user_confirmation', to: 'spec_generation', role: 'pm', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
    { from: 'user_confirmation', to: 'feature_planning', role: 'pm', requiresReason: true, requiresHandoff: false, kind: 'backward', selfCheck: false },
    { from: 'spec_generation', to: 'delivered', role: 'engineer', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
  ],
  roles: {
    user_requirement: { role: 'leader', responsibilities: 'Pick up the requirement and start planning it.' },
    feature_planning: { role: 'leader', responsibilities: 'Plan the feature, then hand it to the user for confirmation.' },
    user_confirmation: { role: 'pm', responsibilities: 'Confirm the plan with the user, or send it back to planning with a reason.' },
    spec_generation: { role: 'engineer', responsibilities: 'Write the spec, then deliver it.' },
    delivered: { role: null, responsibilities: 'Terminal state. The work is delivered; no further action.' },
  },
};

// Flow B: same as A without the confirmation step.
//   User requirement -> Feature planning -> Generate spec -> Delivered
const FLOW_WITHOUT_CONFIRMATION = {
  name: 'Spec flow (no confirmation)',
  states: [
    { code: 'user_requirement', label: 'User requirement', sort_order: 0, is_start: true, is_terminal: false },
    { code: 'feature_planning', label: 'Feature planning', sort_order: 1, is_start: false, is_terminal: false },
    { code: 'spec_generation', label: 'Generate spec', sort_order: 2, is_start: false, is_terminal: false },
    { code: 'delivered', label: 'Delivered', sort_order: 3, is_start: false, is_terminal: true },
  ],
  transitions: [
    { from: 'user_requirement', to: 'feature_planning', role: 'leader', requiresReason: false, requiresHandoff: false, kind: 'pickup', selfCheck: false },
    { from: 'feature_planning', to: 'spec_generation', role: 'leader', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
    { from: 'spec_generation', to: 'delivered', role: 'engineer', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
  ],
  roles: {
    user_requirement: { role: 'leader', responsibilities: 'Pick up the requirement and start planning it.' },
    feature_planning: { role: 'leader', responsibilities: 'Plan the feature, then hand it over for the spec.' },
    spec_generation: { role: 'engineer', responsibilities: 'Write the spec, then deliver it.' },
    delivered: { role: null, responsibilities: 'Terminal state. The work is delivered; no further action.' },
  },
};

// Flow C: a system event becomes an incident, then closes.
//   System event -> Create incident -> Closed
const FLOW_INCIDENT = {
  name: 'Incident flow',
  states: [
    { code: 'system_event', label: 'System event', sort_order: 0, is_start: true, is_terminal: false },
    { code: 'create_incident', label: 'Create incident', sort_order: 1, is_start: false, is_terminal: false },
    { code: 'closed', label: 'Closed', sort_order: 2, is_start: false, is_terminal: true },
  ],
  transitions: [
    { from: 'system_event', to: 'create_incident', role: 'pm', requiresReason: false, requiresHandoff: false, kind: 'pickup', selfCheck: false },
    { from: 'create_incident', to: 'closed', role: 'engineer', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
  ],
  roles: {
    system_event: { role: 'pm', responsibilities: 'Triage the system event and open an incident.' },
    create_incident: { role: 'engineer', responsibilities: 'Handle the incident, then close it.' },
    closed: { role: null, responsibilities: 'Terminal state. The incident is closed; no further action.' },
  },
};

const EXAMPLE_WORKFLOWS = [
  FLOW_WITH_CONFIRMATION,
  FLOW_WITHOUT_CONFIRMATION,
  FLOW_INCIDENT,
];

module.exports = {
  FLOW_WITH_CONFIRMATION,
  FLOW_WITHOUT_CONFIRMATION,
  FLOW_INCIDENT,
  EXAMPLE_WORKFLOWS,
};
