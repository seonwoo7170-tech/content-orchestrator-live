export const JOB_STATES = Object.freeze([
  'queued',
  'writing',
  'critic_review',
  'repairing',
  'final_critic',
  'ready',
  'updating_existing',
  'publishing_new',
  'completed',
  'needs_review',
  'failed'
]);

const TRANSITIONS = Object.freeze({
  queued: ['writing', 'critic_review', 'failed'],
  writing: ['critic_review', 'repairing', 'failed'],
  critic_review: ['repairing', 'final_critic', 'writing', 'ready', 'needs_review', 'failed'],
  repairing: ['critic_review', 'final_critic', 'writing', 'needs_review', 'failed'],
  final_critic: ['repairing', 'writing', 'ready', 'needs_review', 'failed'],
  ready: ['updating_existing', 'publishing_new', 'completed', 'failed'],
  updating_existing: ['completed', 'failed'],
  publishing_new: ['completed', 'failed'],
  completed: [],
  needs_review: ['critic_review', 'repairing', 'failed'],
  failed: []
});

export function assertTransition(from, to) {
  if (!JOB_STATES.includes(from) || !JOB_STATES.includes(to)) throw new Error('JOB_STATE_INVALID');
  if (!TRANSITIONS[from].includes(to)) throw new Error(`JOB_TRANSITION_INVALID:${from}->${to}`);
  return true;
}

export function nextAfterCritic({ mode, criticStatus, repairAttempts = 0, maxRepairAttempts = 3 }) {
  if (!['new_article', 'repair_existing'].includes(mode)) throw new Error('JOB_MODE_INVALID');
  if (!['PASS', 'FAIL'].includes(criticStatus)) throw new Error('CRITIC_STATUS_INVALID');
  if (criticStatus === 'PASS') return 'ready';
  if (repairAttempts >= maxRepairAttempts) return 'needs_review';
  return 'repairing';
}
