const { test } = require('node:test');
const assert = require('node:assert');
const {
  createTeam,
  addMembers,
  setMemberRole,
  removeMember,
} = require('../src/teams');

test('createTeam establishes exactly one owner', () => {
  const team = createTeam({ name: 'alpha', ownerId: 'u1' });
  const owners = team.members.filter((m) => m.role === 'owner');
  assert.strictEqual(owners.length, 1);
  assert.strictEqual(owners[0].userId, 'u1');
});

test('addMembers cannot introduce a second owner', () => {
  const team = createTeam({ name: 'alpha', ownerId: 'u1' });
  assert.throws(() =>
    addMembers(team, [{ userId: 'u2', role: 'owner' }])
  );
  const owners = team.members.filter((m) => m.role === 'owner');
  assert.strictEqual(owners.length, 1);
});

test('setMemberRole cannot assign a role at or above own rank', () => {
  const team = createTeam({ name: 'alpha', ownerId: 'u1' });
  addMembers(team, [{ userId: 'u2', role: 'admin' }]);
  assert.throws(() =>
    setMemberRole(team, { actorId: 'u2', userId: 'u3', role: 'owner' })
  );
  assert.throws(() =>
    setMemberRole(team, { actorId: 'u2', userId: 'u3', role: 'admin' })
  );
});

test('setMemberRole cannot demote a higher-ranked member', () => {
  const team = createTeam({ name: 'alpha', ownerId: 'u1' });
  addMembers(team, [{ userId: 'u2', role: 'admin' }]);
  assert.throws(() =>
    setMemberRole(team, { actorId: 'u2', userId: 'u1', role: 'member' })
  );
});

test('owner cannot be demoted without transfer', () => {
  const team = createTeam({ name: 'alpha', ownerId: 'u1' });
  assert.throws(() =>
    setMemberRole(team, { actorId: 'u1', userId: 'u1', role: 'member' })
  );
  const owners = team.members.filter((m) => m.role === 'owner');
  assert.strictEqual(owners.length, 1);
});

test('removeMember cannot remove the sole owner', () => {
  const team = createTeam({ name: 'alpha', ownerId: 'u1' });
  assert.throws(() => removeMember(team, { actorId: 'u1', userId: 'u1' }));
  const owners = team.members.filter((m) => m.role === 'owner');
  assert.strictEqual(owners.length, 1);
});

test('removeMember cannot remove a higher-ranked member', () => {
  const team = createTeam({ name: 'alpha', ownerId: 'u1' });
  addMembers(team, [{ userId: 'u2', role: 'admin' }]);
  assert.throws(() => removeMember(team, { actorId: 'u2', userId: 'u1' }));
});
