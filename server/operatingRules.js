// Relay standing operating rules (ticket 883eee58): the single
// source of truth for the duty-chat operating rules — the rules every
// role agent works by, wherever they are written down. Both the
// per-role onboarding document ("Your work mode") and the project
// prompt bundle ("Standing operating rules") render from here, so a
// rule change is made once, in this file, and shows up everywhere
// the next time a document is generated. Nothing in the database
// carries these rules; they are standing rules of the Relay duty
// chats, not per-project data.
//
// WORK_MODE_RULES is the five bullets the per-role onboarding
// document has carried since ticket 0f26169c — the wording is kept
// byte-identical so the existing document does not change.
// STANDING_RULES is the full set the project prompt bundle carries:
// the five work-mode rules plus the rules that only make sense at
// project level (English-only, the 12-hour rules sync, and the
// develop-branch rule).
const WORK_MODE_RULES = [
  {
    id: 'five-minute-check',
    text: "Check the queue every 5 minutes for tickets in your role's states; claim one ticket at a time.",
  },
  {
    id: 'one-ticket',
    text: 'Work one ticket to handoff, then claim the next. Never claim several at once.',
  },
  {
    id: 'clarify',
    text: 'If the spec is unclear, send the ticket back for clarification with a reason — do not guess.',
  },
  {
    id: 'verify-before-deliver',
    text: 'Test locally first; only deploy after verification; never deliver what you have not verified.',
  },
  {
    id: 'key-handling',
    text: 'Your API key is read inside a helper script and never printed — not in logs, not in chat.',
  },
];

const STANDING_RULES = [
  ...WORK_MODE_RULES,
  {
    id: 'english-only',
    text: 'Write everything in English: UI text, code, comments, documents, and tickets. Relay is English-only.',
  },
  {
    id: 'twelve-hour-sync',
    text: 'Re-read your onboarding package every 12 hours: the rules and the workflow can change, and the live document is always current.',
  },
  {
    id: 'develop-branch',
    text: 'Develop on the develop branch and push to origin/develop. Never work on main; only merge to main when deployment is approved.',
  },
];

module.exports = {
  WORK_MODE_RULES,
  STANDING_RULES,
};
