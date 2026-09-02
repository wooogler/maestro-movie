/**
 * Executable check for the separation between the three token scopes.
 * No test runner is configured, so this is a plain script:
 *
 *   npx tsx apps/backend/src/study/relayTokenScopes.check.ts
 *
 * WHAT IT IS DEFENDING
 *
 * `relay.join` used to accept `role: 'agent'` with a raw `relaySessionId` and no
 * credential whatsoever, while `relay.joined` echoed that id back to every
 * joiner — including a read-only viewer. So the booth QR, whose URL is printed
 * as text under the code, was enough to: join as a viewer, read the relay
 * session id out of the join reply, open a second socket as an `agent`, and then
 * send anything in AGENT_TO_HOST_TYPES — `tool.call` into the live booking GUI,
 * `agent.message` spoken aloud through the kiosk, `session.end`.
 *
 * The fix has two halves and this file holds both:
 *   1. the agent role now presents an `agent`-scoped token, and
 *   2. only the host is told the relay session id.
 *
 * Half 2 lives in agentRelay.ts and is asserted by reading that source, because
 * standing up a websocket server here would make this check a integration test.
 * Half 1 is asserted against real minted tokens.
 *
 * Runs in a scratch cwd so it never touches the real `.runtime` sessions file,
 * and sets AGENT_SUPERVISOR_DISABLED so creating sessions cannot fork agents.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RELAY_SOURCE = path.join(REPO_ROOT, 'apps/backend/src/routes/agentRelay.ts');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-token-scopes-check-'));
fs.mkdirSync(path.join(scratch, '.runtime'), { recursive: true });
process.chdir(scratch);

// Every study mode has agentEnabled: true, so without this each session created
// below would fork a real agent process and let it write runtime logs.
process.env.AGENT_SUPERVISOR_DISABLED = 'true';
// Deterministic signing key; the real one must not be needed to run a check.
process.env.STUDY_SESSION_SECRET = 'relay-token-scopes-check-secret';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

async function main(): Promise<void> {
  const service = await import('./sessionService');
  const scenarios = service.listScenarios();
  if (scenarios.length === 0) {
    console.error('FAIL: no scenarios available; cannot mint a session to test with.');
    process.exit(1);
  }

  const created = service.createStudySession({
    scenarioId: scenarios[0].id,
    studyMode: 'basic-tuning-voice-off',
    participantId: 'relay-token-scopes-check',
  });

  const { studyToken, viewToken, agentToken } = created;
  const relaySessionId = created.record.relaySessionId;

  section('1. THE THREE TOKENS ARE DISTINCT');
  {
    check('a study token was minted', Boolean(studyToken));
    check('a view token was minted', Boolean(viewToken));
    check('an agent token was minted', Boolean(agentToken));
    check(
      'all three differ',
      new Set([studyToken, viewToken, agentToken]).size === 3
    );
  }

  section('2. EACH TOKEN OPENS ITS OWN DOOR');
  {
    check(
      'the study token resolves a full session context',
      service.getSessionContextByToken(studyToken)?.record.sessionId === created.record.sessionId
    );
    check(
      'the view token resolves the relay session to watch',
      service.getRelaySessionIdByViewToken(viewToken) === relaySessionId
    );
    check(
      'the agent token resolves the relay session to attach to',
      service.getRelaySessionIdByAgentToken(agentToken) === relaySessionId
    );
  }

  section('3. AND NO OTHER — an agent token is not a host token');
  {
    check(
      'the agent token cannot resolve a session context (no host role, no trace, no finish)',
      service.getSessionContextByToken(agentToken) === null
    );
    check(
      'the agent token cannot resolve an API key',
      service.getSessionApiKeyByToken(agentToken) === null
    );
    check(
      'the agent token cannot be used as a view token',
      service.getRelaySessionIdByViewToken(agentToken) === null
    );
  }

  section('4. AND NO OTHER — a view token is not an agent token');
  {
    // This is the escalation the fix exists to stop: the booth QR must not be
    // convertible into agent authority over the session it is watching.
    check(
      'the view token cannot resolve as an agent',
      service.getRelaySessionIdByAgentToken(viewToken) === null
    );
    check(
      'the study token cannot resolve as an agent',
      service.getRelaySessionIdByAgentToken(studyToken) === null
    );
  }

  section('5. THE COMPANION PAIRING — demo only, and only while actually paired');
  {
    // A study session must never be able to hand out phone voice.
    for (const mode of [
      'basic-tuning-voice-off',
      'basic-tuning-voice-on',
      'full-tuning-voice-off',
      'full-tuning-voice-on',
    ] as const) {
      const studySession = service.createStudySession({
        scenarioId: scenarios[0].id,
        studyMode: mode,
        participantId: `scope-check-${mode}`,
      });
      check(
        `${mode} cannot mint a companion pairing`,
        service.createCompanionToken(studySession.studyToken) === null
      );
    }

    const demo = service.createStudySession({
      scenarioId: scenarios[0].id,
      studyMode: 'demo',
      participantId: 'scope-check-demo',
      apiKey: 'sk-check-session-bound-key',
    });

    const pairing = service.createCompanionToken(demo.studyToken);
    check('a demo session can mint a companion pairing', pairing !== null);
    if (!pairing) {
      console.error('FAIL: cannot continue companion checks without a pairing.');
      process.exit(1);
    }
    const companionToken = pairing.companionToken;

    check(
      'the companion token names the relay session',
      service.getRelaySessionIdByCompanionToken(companionToken) === demo.record.relaySessionId
    );

    section('6. THE COMPANION TOKEN OPENS NO OTHER DOOR');
    check(
      'it cannot resolve a session context',
      service.getSessionContextByToken(companionToken) === null
    );
    check(
      'it cannot resolve an API key through the study accessor',
      service.getSessionApiKeyByToken(companionToken) === null
    );
    check(
      'it cannot be used as a view token',
      service.getRelaySessionIdByViewToken(companionToken) === null
    );
    check(
      'it cannot be used as an agent token',
      service.getRelaySessionIdByAgentToken(companionToken) === null
    );
    check(
      'the demo study token cannot be used as a companion token',
      service.getRelaySessionIdByCompanionToken(demo.studyToken) === null
    );
    check(
      'the demo view token cannot be used as a companion token',
      service.getRelaySessionIdByCompanionToken(demo.viewToken) === null
    );

    section('7. SPENDING THE SESSION KEY REQUIRES ACTUALLY BEING PAIRED');
    {
      // This is what bounds the operator key at a booth: the access-code flow
      // copies OPENAI_API_KEY into the session, so "the handler never reads the
      // env" would prove nothing. Photographing the QR must not be enough.
      check(
        'a token that never attached to the relay can mint nothing',
        service.consumeCompanionApiKey(companionToken) === null
      );

      service.setCompanionAttached(demo.record.relaySessionId, true);
      check(
        'an attached phone can mint',
        service.consumeCompanionApiKey(companionToken) === 'sk-check-session-bound-key'
      );

      // The gate is live attachment, not a spend-down budget. An earlier version
      // granted N mints per relay join, which a phone could exhaust through its
      // own reconnect ladder without ever detaching — permanently mute, page
      // reload the only cure.
      const repeated: (string | null)[] = [];
      for (let i = 0; i < 6; i += 1) repeated.push(service.consumeCompanionApiKey(companionToken));
      check(
        'ordinary retries do not exhaust an attached phone',
        repeated.every((value) => value === 'sk-check-session-bound-key'),
        `${repeated.filter((v) => v === null).length} of 6 retries were refused`
      );

      check(
        'a rolling rate limit still bounds it',
        Array.from({ length: 40 }, () => service.consumeCompanionApiKey(companionToken)).some(
          (value) => value === null
        )
      );

      service.setCompanionAttached(demo.record.relaySessionId, false);
      check(
        'detaching closes the gate again',
        service.consumeCompanionApiKey(companionToken) === null
      );
      service.setCompanionAttached(demo.record.relaySessionId, true);
    }

    section('8. RE-PAIRING REVOKES THE PREVIOUS PHONE');
    {
      const second = service.createCompanionToken(demo.studyToken);
      check('a second pairing can be minted', second !== null);
      check(
        'the first companion token stops resolving',
        service.getRelaySessionIdByCompanionToken(companionToken) === null
      );
      check(
        'the second one works',
        second !== null &&
          service.getRelaySessionIdByCompanionToken(second.companionToken) ===
            demo.record.relaySessionId
      );
      check(
        'and the revoked token can no longer spend the key',
        service.consumeCompanionApiKey(companionToken) === null
      );
    }
  }

  section('9. A FINISHED SESSION CLOSES ALL THREE DOORS');
  {
    service.finishSessionByToken(studyToken);
    check(
      'the agent token stops resolving',
      service.getRelaySessionIdByAgentToken(agentToken) === null
    );
    check(
      'the view token stops resolving',
      service.getRelaySessionIdByViewToken(viewToken) === null
    );
    check(
      'the study token stops resolving',
      service.getSessionContextByToken(studyToken) === null
    );
  }

  section('10. THE RELAY SOURCE STILL HOLDS ITS HALF');
  {
    const relaySource = fs.readFileSync(RELAY_SOURCE, 'utf-8');
    check(
      'the agent role requires payload.agentToken',
      relaySource.includes('getRelaySessionIdByAgentToken'),
      'agentRelay.ts no longer resolves an agent token'
    );
    check(
      "relay.joined returns sessionId only for the host",
      /\.\.\.\(role === 'host' \? \{ sessionId \} : \{\}\)/.test(relaySource),
      'the relay session id may be leaking to non-host roles again'
    );
    // Belt and braces for the assertion above: pull the relay.joined payload
    // block out by hand and prove no line in it is a bare `sessionId,`. The
    // regex form of this missed a reintroduced leak once, because the comment
    // explaining the guard pushed the offending line outside the match window.
    const joinedAt = relaySource.indexOf("type: 'relay.joined',");
    const joinedBlock = joinedAt >= 0 ? relaySource.slice(joinedAt, joinedAt + 900) : '';
    check('the relay.joined block was located', joinedAt >= 0);
    // The scrub runs on every inbound frame, relay.join included. If it ever
    // starts matching a *Token key, every join in every condition breaks.
    const secretPattern = /^(x[-_])?(openai[-_]?)?api[-_]?key$|^client[-_]?secret$|^ephemeral[-_]?key$/i;
    check(
      'the relay secret scrub still strips credential-shaped keys',
      ['apiKey', 'api_key', 'x-api-key', 'clientSecret', 'client_secret', 'ephemeral_key'].every(
        (key) => secretPattern.test(key)
      )
    );
    check(
      'and never strips a join token',
      ['studyToken', 'agentToken', 'viewToken', 'companionToken'].every(
        (key) => !secretPattern.test(key)
      )
    );
    check(
      'the pattern in the check matches the one in the relay',
      relaySource.includes(secretPattern.source.replace(/\//g, '\\/')) ||
        relaySource.includes('^client[-_]?secret$'),
      'SECRET_PAYLOAD_KEY_PATTERN drifted from the copy asserted here'
    );
    /*
      Preference-memory mutation is a host-only power. The visitor is standing
      at the kiosk; the phone's job is the microphone and the second screen's is
      to be looked at. Both hold credentials that were handed out in a room, so
      the day one of these strings appears in a companion or agent-facing set,
      this check is what says so.
    */
    const setBlock = (name: string): string => {
      const at = relaySource.indexOf(`const ${name} = new Set(`);
      return at >= 0 ? relaySource.slice(at, relaySource.indexOf(']);', at)) : '';
    };

    /*
      The device roster is demo-only and never logged, and both facts are
      enforced inside `notifySessionDevices` rather than at its call sites, so
      that a future caller cannot leak it into a study session by forgetting a
      guard. Asserted by reading the source because standing up a websocket
      server here would make this an integration test.
    */
    const devicesFn = relaySource.slice(
      relaySource.indexOf('function notifySessionDevices('),
      relaySource.indexOf('function notifySessionPresence(')
    );
    check('notifySessionDevices was located', devicesFn.length > 0);
    check(
      'it refuses any session that is not a demo, on its first line',
      /\{\s*if \(!isDemoRelaySession\(sessionId\)\) return;/.test(devicesFn),
      'the device roster could reach a study session'
    );
    check(
      'and it never writes a log line',
      !devicesFn.includes('appendSessionLog'),
      'the roster would renumber every event in a study session log'
    );
    // The roster reaches viewers, and the relay session id is deliberately
    // withheld from every non-host role.
    const rosterFn = relaySource.slice(
      relaySource.indexOf('function buildDeviceRosterPayload('),
      relaySource.indexOf('function notifySessionDevices(')
    );
    check('buildDeviceRosterPayload was located', rosterFn.length > 0);
    // Only what is RETURNED — `sessionId` is also the function's own parameter.
    const rosterReturns = rosterFn
      .split('return {')
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf('};')))
      .join('\n');
    check('the roster payload returns were located', rosterReturns.length > 0);
    check(
      'the roster payload carries no sessionId',
      !/sessionId/.test(rosterReturns),
      'the relay session id would leak to viewers'
    );
    // A heartbeat that answered HOST_UNAVAILABLE would knock a working phone
    // out of capture every few seconds, so it must terminate at the relay.
    check(
      'companion.ping is a companion -> host type',
      setBlock('COMPANION_TO_HOST_TYPES').includes(`'companion.ping'`)
    );
    check(
      'and it is handled before relayCompanionToHost',
      relaySource.indexOf("message.type === 'companion.ping'") <
        relaySource.indexOf('relayCompanionToHost(client, message);'),
      'a heartbeat would be answered with HOST_UNAVAILABLE while the kiosk is on the QR screen'
    );

    const memoryMutationTypes = [
      'memory.preference.delete',
      'memory.preference.clear',
      'memory.preference.restore',
      'memory.profile.load',
    ];
    const hostToAgentBlock = setBlock('HOST_TO_AGENT_TYPES');
    check('the HOST_TO_AGENT_TYPES block was located', hostToAgentBlock.length > 0);
    /*
      The phone may ASK, over its own lane, and the kiosk decides. That frame is
      `companion.memory.command` and it must stay a `companion.*` type: naming
      it after an agent-facing type would let `relayToAgents` route a phone's
      frame straight through, which is the whole reason the companion prefix
      exists.
    */
    const companionToHostBlock = setBlock('COMPANION_TO_HOST_TYPES');
    check(
      'the phone may ask the kiosk to change memory',
      companionToHostBlock.includes(`'companion.memory.command'`)
    );
    check(
      'and that request is not itself an agent-facing type',
      !hostToAgentBlock.includes(`'companion.memory.command'`),
      'a phone frame could be routed straight to the agent'
    );

    for (const type of memoryMutationTypes) {
      check(
        `${type} is host -> agent`,
        hostToAgentBlock.includes(`'${type}'`),
        'the host can no longer reach preference memory'
      );
      for (const other of [
        'AGENT_TO_HOST_TYPES',
        'HOST_TO_COMPANION_TYPES',
        'COMPANION_TO_HOST_TYPES',
        'AGENT_TO_COMPANION_TYPES',
      ]) {
        const block = setBlock(other);
        check(
          `${type} is absent from ${other}`,
          block.length === 0 || !block.includes(`'${type}'`),
          `${other} would let a non-host role rewrite preference memory`
        );
      }
    }

    check(
      'no unconditional bare `sessionId,` line in the relay.joined payload',
      joinedBlock.length > 0 &&
        !joinedBlock
          .split('\n')
          .some((line) => line.trim() === 'sessionId,'),
      'a bare sessionId line is back in the relay.joined payload'
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} relay token-scope check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll relay token-scope checks passed.');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
