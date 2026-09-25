import { randomUUID } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';

/**
 * Team/organization accounts: a named group of Stellar addresses that can
 * see each other's question history and spend in one place. Identity stays
 * exactly what it is everywhere else in this backend — a Stellar address
 * proven with a session token (POST /payers/:address/session). A team adds
 * no new credential; it's a membership list over existing identities, so
 * every member keeps paying from, and owning, their own address.
 *
 * Roles, strongest first:
 *  - owner:  exactly one per team. Everything an admin can do, plus
 *            promoting/demoting admins, transferring ownership, and
 *            deleting the team. Can't leave or be removed without first
 *            transferring ownership, so a team is never ownerless.
 *  - admin:  add and remove plain members, rename the team.
 *  - member: read the team and its combined question history; leave.
 *
 * Storage mirrors privatePools.js: team:{id} holds the record, and each
 * address has a team-memberships:{address} list so "my teams" is one
 * lookup, plus a bounded index of every team id for the admin console. No
 * TTLs — durable, same choice as reputation. Members must be valid Stellar
 * addresses for the same reason private-pool entries must be: a test-string
 * id carries no proof of identity (see workerAuth.js's requiresAuth()).
 */

const TEAM_PREFIX = 'team:';
const MEMBERSHIP_PREFIX = 'team-memberships:';
const TEAM_INDEX_KEY = 'known-team-ids';
const MAX_TRACKED_TEAMS = 5_000;

export const MAX_TEAM_MEMBERS = 100;
export const MAX_TEAMS_PER_ADDRESS = 20;
export const MAX_TEAM_NAME_LENGTH = 80;
export const ROLES = Object.freeze(['owner', 'admin', 'member']);
const RANK = { owner: 3, admin: 2, member: 1 };

/** `status` is the HTTP status the route should answer with. */
export class TeamError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function isValidMemberAddress(address) {
  return typeof address === 'string' && StrKey.isValidEd25519PublicKey(address);
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new TeamError('name (non-empty string) is required');
  const trimmed = name.trim();
  if (trimmed.length > MAX_TEAM_NAME_LENGTH) {
    throw new TeamError(`name must be at most ${MAX_TEAM_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function validateAssignableRole(role) {
  if (role !== 'admin' && role !== 'member') throw new TeamError("role must be 'admin' or 'member'");
}

export function roleOf(team, address) {
  return team.members.find((m) => m.address === address)?.role ?? null;
}

/** Whether `address` holds at least `minRole` in `team`. Pure. */
export function hasRole(team, address, minRole) {
  const role = roleOf(team, address);
  return role !== null && RANK[role] >= RANK[minRole];
}

async function getMemberships(address) {
  return (await store.get(MEMBERSHIP_PREFIX + address)) || [];
}

async function addMembership(address, teamId) {
  const existing = await getMemberships(address);
  if (existing.includes(teamId)) return;
  if (existing.length >= MAX_TEAMS_PER_ADDRESS) {
    throw new TeamError(`${address} already belongs to the maximum of ${MAX_TEAMS_PER_ADDRESS} teams`, 409);
  }
  await store.set(MEMBERSHIP_PREFIX + address, [teamId, ...existing]);
}

async function removeMembership(address, teamId) {
  const existing = await getMemberships(address);
  const next = existing.filter((id) => id !== teamId);
  if (next.length === existing.length) return;
  if (next.length === 0) await store.delete(MEMBERSHIP_PREFIX + address);
  else await store.set(MEMBERSHIP_PREFIX + address, next);
}

export async function getTeam(teamId) {
  if (typeof teamId !== 'string' || !teamId) return null;
  return store.get(TEAM_PREFIX + teamId);
}

/**
 * Loads a team and checks the actor holds at least `minRole`. Answers 404
 * (not 403) to non-members, so team ids can't be probed by outsiders —
 * same convention as DELETE /webhooks/:id.
 */
export async function requireTeamRole(teamId, actor, minRole) {
  const team = await getTeam(teamId);
  if (!team || roleOf(team, actor) === null) throw new TeamError('no such team', 404);
  if (!hasRole(team, actor, minRole)) throw new TeamError(`requires the ${minRole} role on this team`, 403);
  return team;
}

async function saveTeam(team) {
  team.updatedAt = Date.now();
  await store.set(TEAM_PREFIX + team.id, team);
  return team;
}

export async function listKnownTeamIds() {
  return (await store.get(TEAM_INDEX_KEY)) || [];
}

export async function createTeam(ownerAddress, name) {
  if (!isValidMemberAddress(ownerAddress)) throw new TeamError('team owner must be a valid Stellar address');
  const now = Date.now();
  const team = {
    id: `team_${randomUUID()}`,
    name: validateName(name),
    createdAt: now,
    createdBy: ownerAddress,
    members: [{ address: ownerAddress, role: 'owner', addedAt: now, addedBy: ownerAddress }],
  };
  // Membership first: it's the step that can fail (per-address cap), and
  // failing before the team record exists leaves nothing to clean up.
  await addMembership(ownerAddress, team.id);
  await saveTeam(team);

  const known = await listKnownTeamIds();
  await store.set(TEAM_INDEX_KEY, [team.id, ...known].slice(0, MAX_TRACKED_TEAMS));
  return team;
}

/** Every team `address` belongs to. Stale ids (a deleted team whose
 * membership cleanup was interrupted) are skipped, not surfaced. */
export async function listTeamsFor(address) {
  const ids = await getMemberships(address);
  const teams = await Promise.all(ids.map((id) => getTeam(id)));
  return teams.filter((t) => t && roleOf(t, address) !== null);
}

export async function renameTeam(teamId, actor, name) {
  const team = await requireTeamRole(teamId, actor, 'admin');
  team.name = validateName(name);
  return saveTeam(team);
}

/**
 * Adds members. Admins may add plain members; only the owner may add
 * admins. Rejects the whole call rather than partially applying it, same
 * as privatePools.js's addPoolWorkers(), so a caller never has to work out
 * which half of a request took effect.
 */
export async function addMembers(teamId, actor, addresses, role = 'member') {
  validateAssignableRole(role);
  const team = await requireTeamRole(teamId, actor, role === 'admin' ? 'owner' : 'admin');
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new TeamError('members must be a non-empty array of Stellar addresses');
  }
  const invalid = addresses.filter((a) => !isValidMemberAddress(a));
  if (invalid.length > 0) throw new TeamError(`not valid Stellar addresses: ${invalid.map(String).join(', ')}`);

  const additions = [...new Set(addresses)].filter((a) => roleOf(team, a) === null);
  if (team.members.length + additions.length > MAX_TEAM_MEMBERS) {
    throw new TeamError(`a team can have at most ${MAX_TEAM_MEMBERS} members`, 409);
  }
  if (additions.length === 0) return team;

  // Membership caps are checked up front for every address, so a cap hit on
  // the last address can't leave the first few half-added.
  const full = [];
  for (const address of additions) {
    if ((await getMemberships(address)).length >= MAX_TEAMS_PER_ADDRESS) full.push(address);
  }
  if (full.length > 0) {
    throw new TeamError(`already in the maximum of ${MAX_TEAMS_PER_ADDRESS} teams: ${full.join(', ')}`, 409);
  }

  const now = Date.now();
  for (const address of additions) {
    await addMembership(address, teamId);
    team.members.push({ address, role, addedAt: now, addedBy: actor });
  }
  return saveTeam(team);
}

/**
 * Changes a member's role. Only the owner may do this. Setting another
 * member's role to 'owner' transfers ownership: they become owner and the
 * previous owner becomes an admin, so there's always exactly one owner.
 */
export async function setMemberRole(teamId, actor, target, role) {
  if (!ROLES.includes(role)) throw new TeamError(`role must be one of ${ROLES.join(', ')}`);
  const team = await requireTeamRole(teamId, actor, 'owner');
  const member = team.members.find((m) => m.address === target);
  if (!member) throw new TeamError('that address is not a member of this team', 404);
  if (target === actor) {
    throw new TeamError('the owner cannot change their own role — transfer ownership to another member instead', 409);
  }

  if (role === 'owner') {
    team.members.find((m) => m.address === actor).role = 'admin';
  }
  member.role = role;
  return saveTeam(team);
}

/**
 * Removes a member. Anyone may remove themselves (leave); admins may remove
 * plain members; the owner may remove anyone but themselves. The owner can
 * never leave while they're the owner — transfer first.
 */
export async function removeMember(teamId, actor, target) {
  const team = await requireTeamRole(teamId, actor, 'member');
  const targetRole = roleOf(team, target);
  if (targetRole === null) throw new TeamError('that address is not a member of this team', 404);
  if (targetRole === 'owner') {
    throw new TeamError('the owner cannot be removed — transfer ownership first, or delete the team', 409);
  }
  if (target !== actor) {
    const required = targetRole === 'admin' ? 'owner' : 'admin';
    if (!hasRole(team, actor, required)) throw new TeamError(`requires the ${required} role on this team`, 403);
  }

  team.members = team.members.filter((m) => m.address !== target);
  await saveTeam(team);
  await removeMembership(target, teamId);
  return team;
}

export async function deleteTeam(teamId, actor) {
  const team = await requireTeamRole(teamId, actor, 'owner');
  await store.delete(TEAM_PREFIX + teamId);
  await Promise.all(team.members.map((m) => removeMembership(m.address, teamId)));
  const known = await listKnownTeamIds();
  await store.set(TEAM_INDEX_KEY, known.filter((id) => id !== teamId));
  return true;
}
