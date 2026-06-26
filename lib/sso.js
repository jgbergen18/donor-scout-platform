/**
 * SSO claims → user resolution (SaaS auth Phase 2 — per-org Okta OIDC).
 * ------------------------------------------------------------------
 * This is the SECURITY-CRITICAL core of enterprise SSO, deliberately written as
 * a PURE function so it is fully unit-testable OFFLINE — the live OIDC handshake
 * (discovery, code exchange, ID-token signature/issuer/audience verification)
 * needs a real Okta + HTTPS and CANNOT run in CI. The route does the network +
 * cryptographic verification via openid-client and then hands ALREADY-VERIFIED
 * claims to this function; tests drive it directly with injected claims (or via
 * the NODE_ENV=test fake-claims hook).
 *
 * THE TENANT-ISOLATION INVARIANT: the org and the role come from the matched
 * org's IdP-config ROW and group_role_map — NEVER from IdP-supplied input used to
 * cross tenants. The caller resolves the org from a VERIFIED email domain and the
 * config row; this function additionally asserts the token's issuer matches the
 * org's configured issuer, so an Okta token for org A can never resolve to org B.
 *
 * Resolution order (mirrors Phase 1's newUserResolution funnel):
 *   1. Existing `okta` identity (provider_sub = Okta `sub`) → that user. If their
 *      org differs from the resolving org → REJECT (cross-org). If deactivated →
 *      REJECT. Otherwise refresh the group→role mapping and log in.
 *   2. No okta identity but an existing user (by email) in THIS org →
 *      attach an okta identity, apply group→role, log in.
 *   3. No user yet:
 *        - JIT on  → create the user in THIS org with the group-mapped role
 *                    (default 'member'), attach an okta identity.
 *        - JIT off → require a live invitation for this org (else REJECT).
 *
 * The function never touches the DB directly; it calls injected operations so the
 * server wires in its prepared statements and tests inject in-memory fakes.
 */

// Map an Okta groups claim to an app role via the org's group_role_map. First
// matching group wins, ranked owner > admin > member so the highest privilege a
// user's groups grant is the one applied. Returns null when nothing matches (the
// caller decides the default, e.g. 'member' for JIT).
export function mapGroupsToRole(groups, groupRoleMap) {
  if (!groupRoleMap || typeof groupRoleMap !== 'object') return null;
  const list = Array.isArray(groups) ? groups : groups == null ? [] : [groups];
  const rank = { owner: 3, admin: 2, member: 1 };
  let best = null;
  for (const g of list) {
    const role = groupRoleMap[g];
    if (role && rank[role] && (!best || rank[role] > rank[best])) best = role;
  }
  return best;
}

/**
 * Pure resolver. Throws an Error tagged with `.code` on any rejection so the
 * route can map it to an HTTP response + audit event.
 *
 * @param {object} args
 * @param {object} args.claims     ALREADY-VERIFIED ID-token claims { sub, email, groups?, iss? }.
 * @param {object} args.org        The resolving org row { id }.
 * @param {object} args.config     The org's idp config row { issuer, group_role_map, jit_provisioning }.
 * @param {object} args.ops        Injected operations (DB or fakes), see below.
 * @returns {{ user, created:boolean, role:string }}
 */
export function resolveSsoUser({ claims, org, config, ops }) {
  const sub = claims?.sub;
  const email = (claims?.email || '').toString().trim().toLowerCase();
  if (!sub) throw tagged('Missing subject claim.', 'missing_sub');
  if (!org || !config) throw tagged('No SSO configuration for this org.', 'no_config');

  // Defense-in-depth: even though the route uses openid-client to verify the
  // ID-token issuer/audience/signature, re-assert that the token's issuer matches
  // THIS org's configured issuer. A token minted by org B's Okta therefore can
  // never be replayed to resolve a user in org A.
  if (claims.iss && config.issuer && claims.iss !== config.issuer) {
    throw tagged('Token issuer does not match the org configuration.', 'issuer_mismatch');
  }

  const groupRoleMap = parseMap(config.group_role_map);
  const mappedRole = mapGroupsToRole(claims.groups, groupRoleMap);

  // 1. Existing okta identity.
  const byIdentity = ops.findUserByIdentity('okta', sub);
  if (byIdentity) {
    // Cross-org safety: the identity's user must belong to the org we resolved
    // from the verified domain + issuer. (Should be impossible to violate given
    // UNIQUE(domain) + issuer check, but we assert it as the hard invariant.)
    if (byIdentity.org_id !== org.id) {
      throw tagged('Account belongs to a different organization.', 'cross_org');
    }
    if (byIdentity.is_active === 0) throw tagged('This account has been deactivated.', 'deactivated');
    const role = mappedRole || byIdentity.org_role || 'member';
    if (mappedRole && mappedRole !== byIdentity.org_role) ops.setUserRole(byIdentity.id, org.id, mappedRole);
    ops.ensureIdentity(byIdentity.id, 'okta', sub, email || null);
    return { user: ops.reload(byIdentity.id), created: false, role };
  }

  // 2. Existing user by email IN THIS ORG (link a new okta identity to them).
  if (email) {
    const byEmail = ops.findUserByEmailInOrg(email, org.id);
    if (byEmail) {
      if (byEmail.is_active === 0) throw tagged('This account has been deactivated.', 'deactivated');
      const role = mappedRole || byEmail.org_role || 'member';
      if (mappedRole && mappedRole !== byEmail.org_role) ops.setUserRole(byEmail.id, org.id, mappedRole);
      ops.ensureIdentity(byEmail.id, 'okta', sub, email);
      return { user: ops.reload(byEmail.id), created: false, role };
    }
  }

  // 3. No user yet → JIT-create, or require an invitation.
  if (config.jit_provisioning) {
    const role = mappedRole || 'member';
    const user = ops.createUser({ email, orgId: org.id, role, sub });
    return { user, created: true, role };
  }

  // JIT off: a live invitation for THIS org is required (org/role from the ROW).
  const invite = email ? ops.findLiveInvitation(email, org.id) : null;
  if (invite) {
    const role = mappedRole || (invite.role === 'admin' ? 'admin' : 'member');
    const user = ops.createUser({ email, orgId: org.id, role, sub, inviteId: invite.id });
    return { user, created: true, role };
  }

  throw tagged('No account for this user — an invitation is required.', 'no_invite');
}

function parseMap(json) {
  if (!json) return null;
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function tagged(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}
