import test from "node:test";
import assert from "node:assert/strict";
import { sessionsToRevoke } from "../../src/modules/access/session-cap.js";

const now = new Date("2026-10-17T12:00:00Z");
const at = (m) => new Date(now.getTime() - m * 60_000);
const live = (id, minutesAgo) => ({ id, createdAt: at(minutesAgo), revokedAt: null, expiresAt: new Date(now.getTime() + 86_400_000) });

test("abaixo do teto nada é revogado", () => {
  assert.deepEqual(sessionsToRevoke([live("a", 30), live("b", 20)], 3, now), []);
});

test("no teto, abre espaço revogando a MAIS ANTIGA", () => {
  assert.deepEqual(sessionsToRevoke([live("a", 30), live("b", 20), live("c", 10)], 3, now), ["a"]);
});

test("acima do teto revoga o excesso, sempre as mais antigas, independente da ordem de entrada", () => {
  const r = sessionsToRevoke([live("c", 10), live("a", 50), live("d", 5), live("b", 30)], 2, now);
  assert.deepEqual(r.sort(), ["a", "b", "c"]);
});

test("sessões já revogadas ou expiradas não contam para o teto nem são revogadas de novo", () => {
  const dead = { ...live("x", 90), revokedAt: at(60) };
  const old = { ...live("y", 80), expiresAt: at(1) };
  assert.deepEqual(sessionsToRevoke([dead, old, live("a", 30)], 2, now), []);
});

test("teto 1 (ou inválido) deixa só a nova: revoga todas as vivas", () => {
  assert.deepEqual(sessionsToRevoke([live("a", 3), live("b", 2)], 1, now).sort(), ["a", "b"]);
  assert.deepEqual(sessionsToRevoke([live("a", 3)], 0, now), ["a"]);
});

test("derrubar a TV exige várias recuperações: com teto 3, a sessão da TV legítima sobrevive a 2 chamadas de terceiros", () => {
  let sessions = [live("tv", 100)];
  for (const [i, id] of ["atk1", "atk2"].entries()) {
    const kill = sessionsToRevoke(sessions, 3, now);
    sessions = sessions.filter((s) => !kill.includes(s.id)).concat(live(id, 10 - i));
  }
  assert.ok(sessions.some((s) => s.id === "tv"));
  const kill3 = sessionsToRevoke(sessions, 3, now);
  assert.deepEqual(kill3, ["tv"], "só na 3ª chamada a mais antiga (a TV) cai");
});
