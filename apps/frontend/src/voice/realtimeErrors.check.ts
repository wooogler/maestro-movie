/**
 * Executable check for the Realtime error matcher (voice/realtimeErrors.ts):
 *
 *   npx tsx apps/frontend/src/voice/realtimeErrors.check.ts
 *
 * The fixture shapes are the ones the fake-mic runs recorded on 2026-10-24.
 * Exit code 0 means every case passed.
 */
import { matchRealtimeError, realtimeErrorClientEventId } from './realtimeErrors';

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Recorded live: the server's own id at the top, ours inside `error`.
const cancelNotActive = {
  type: 'error',
  event_id: 'event_EchpFbQEWeNGqvEfs6XyV',
  error: {
    type: 'invalid_request_error',
    code: 'response_cancel_not_active',
    message: 'Cancellation failed: no active response found',
    param: null,
    event_id: 'bargein-cancel-2',
  },
};

console.log('\nclient event id');
check('reads error.event_id, not the server id', realtimeErrorClientEventId(cancelNotActive) === 'bargein-cancel-2');
check(
  'falls back to the top-level event_id if error carries none',
  realtimeErrorClientEventId({ type: 'error', event_id: 'speak-3', error: { message: 'x' } }) === 'speak-3'
);
check(
  'blank or missing ids are null',
  realtimeErrorClientEventId({ type: 'error', error: { event_id: '  ' } }) === null &&
    realtimeErrorClientEventId({ type: 'error' }) === null
);
check(
  'a non-object error does not throw',
  realtimeErrorClientEventId({ type: 'error', error: 'boom', event_id: 'speak-1' }) === 'speak-1'
);

console.log('\nmatching');
const bargeIn = new Set(['bargein-cancel-2', 'bargein-clear-2']);
const ctx = { bargeInEventIds: bargeIn, activeSpeakEventId: 'speak-7' };
check(
  'a barge-in cancel that found no response is swallowed (was logged before the fix)',
  matchRealtimeError(realtimeErrorClientEventId(cancelNotActive), ctx) === 'barge-in'
);
check(
  '…and the same event matched the OLD way (top-level id) is not',
  matchRealtimeError(cancelNotActive.event_id, ctx) === 'other'
);
const speakRejected = { type: 'error', event_id: 'event_abc', error: { code: 'invalid_value', event_id: 'speak-7' } };
check(
  "the active utterance's rejected response.create releases it",
  matchRealtimeError(realtimeErrorClientEventId(speakRejected), ctx) === 'speak-rejected'
);
check(
  "an earlier utterance's rejection is not the active one",
  matchRealtimeError('speak-6', ctx) === 'other'
);
check('no active utterance: no speak match', matchRealtimeError('speak-7', { bargeInEventIds: bargeIn, activeSpeakEventId: null }) === 'other');
check(
  'push-to-talk commit and clear ids keep their own matches',
  matchRealtimeError('ptt-commit-3', ctx) === 'ptt-commit' && matchRealtimeError('ptt-clear-9', ctx) === 'ptt-clear'
);
check('an unknown client id is a real error', matchRealtimeError('something-else', ctx) === 'other');
check('no id at all is a real error', matchRealtimeError(null, ctx) === 'other');

console.log(failures === 0 ? '\nall realtime-error checks passed' : `\n${failures} realtime-error check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
