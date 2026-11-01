# RBAC and permission-management UI

**Status:** proposed product design for M1/M2 review  
**Audience:** project owner, security owner, frontend/backend implementers  
**Scope:** drone operators and telemetry viewers in the management system  
**Out of scope:** flight-control commands, mission upload, autonomy authorization, safety-failsafe control, and aircraft adapter credentials

## 1. Design principles

1. **Deny by default.** A user sees no aircraft, telemetry, maintenance record, or evidence until an active assignment grants the corresponding permission.
2. **Separate observation from administration.** Reading telemetry is not permission to change users, roles, aircraft inventory, maintenance records, or access policy.
3. **Scope every grant.** A role is assigned at an organization/site/fleet/aircraft scope. The UI must show the resolved scope in plain language before saving.
4. **No hidden escalation.** The interface never implies that an operator can control an aircraft. There is no `aircraft.command.*` permission in this model.
5. **Explain effective access.** Users and administrators can inspect why a user can see a particular aircraft: role, assignment, scope, status, and expiry.
6. **Make simulation visible.** Telemetry source and environment remain visible in every live-monitoring view; a viewer role does not turn simulated data into aircraft data.
7. **Audit every access-policy mutation.** Create/update/revoke role assignments, role changes, invitations, token/session revocations, and policy changes produce audit events without storing tokens or secrets.

## 2. Initial roles

System roles are immutable in the first release. Administrators assign roles; they do not edit the permission contents of system roles. Custom roles can be a later phase after permission usage is measured.

| Role | Intended user | Permissions | Default scope |
|---|---|---|---|
| **Telemetry Viewer** | Read-only analyst, stakeholder, support viewer | `aircraft.read`, `telemetry.latest.read`, `telemetry.history.read`, `telemetry.stream.read`, `evidence.read`, `maintenance.read` | Explicit fleet/site/aircraft assignment; never organization-wide by default |
| **Drone Operator** | Authorized operator monitoring assigned aircraft and maintaining operational records | All Telemetry Viewer permissions plus `maintenance.write`, `operations.annotation.write`, `incident.read`, `incident.write` | Explicit assigned fleet/site/aircraft set; no access-policy administration |
| **Access Administrator** | Manages users, roles, assignments, and access audit | `users.read`, `users.invite`, `users.suspend`, `roles.read`, `assignments.read`, `assignments.write`, `audit.access.read` | Organization or delegated site scope |
| **System Administrator** | Break-glass/platform owner | Access Administrator plus system configuration permissions approved separately | Explicitly approved organization scope; MFA and enhanced audit required |

No initial role grants telemetry ingestion, source registration, device credentials, aircraft commands, mission changes, model authorization, or safety-policy changes.

## 3. Permission catalog

Permissions are stable machine identifiers. The UI displays the human description and resource scope; the API authorizes the identifier.

| Permission | Description | Viewer | Operator | Access admin |
|---|---|---:|---:|---:|
| `aircraft.read` | List and view assigned aircraft identity/lifecycle | yes | yes | optional read-only |
| `telemetry.latest.read` | Read current state/freshness for assigned aircraft | yes | yes | no implicit telemetry access |
| `telemetry.history.read` | Read bounded historical telemetry | yes | yes | no implicit telemetry access |
| `telemetry.stream.read` | Subscribe to live stream for assigned aircraft/source | yes | yes | no implicit telemetry access |
| `evidence.read` | Read evidence and provenance references | yes | yes | no implicit telemetry access |
| `maintenance.read` | Read maintenance records | yes | yes | no |
| `maintenance.write` | Create/update maintenance records | no | yes | no |
| `operations.annotation.write` | Add operational notes/annotations | no | yes | no |
| `incident.read` / `incident.write` | Read/create incident records | no | yes | no |
| `users.read` | View non-secret user directory fields | no | no | yes |
| `users.invite` | Invite a user into the organization | no | no | yes |
| `users.suspend` | Suspend/revoke a user account | no | no | yes |
| `roles.read` | View role definitions and permission descriptions | no | no | yes |
| `assignments.read` | View role assignments and effective access | no | no | yes |
| `assignments.write` | Grant, change, expire, or revoke assignments | no | no | yes |
| `audit.access.read` | Read access-policy and authentication audit events | no | no | yes |

The API must reject unknown permissions and must not accept client-supplied role names as proof of authorization. `aircraft.command.*`, `mission.write`, `autonomy.authorize`, and `device.credentials.read` are intentionally absent.

## 4. Access model

### 4.1 Entities

```text
Organization
  └─ Site / operating area
       └─ Fleet / group
            └─ Aircraft

User ──< RoleAssignment >── Role
                      └── ResourceScope
```

A `RoleAssignment` contains:

```json
{
  "assignment_id": "assign-01H...",
  "user_id": "user-01H...",
  "role_id": "telemetry-viewer",
  "scope": {
    "type": "aircraft",
    "ids": ["sim-ucas-001"]
  },
  "source": "direct",
  "status": "active",
  "starts_at": "2026-10-17T14:00:00Z",
  "expires_at": "2026-10-24T14:00:00Z",
  "reason": "Synthetic telemetry review",
  "created_by": "user-admin-01H...",
  "created_at": "2026-10-17T14:00:00Z",
  "updated_at": "2026-10-17T14:00:00Z",
  "version": 1
}
```

### 4.2 Scope rules

- `organization` scope is only available to System Administrator and explicitly approved Access Administrator assignments.
- `site`, `fleet`, and `aircraft` scopes resolve to current membership at authorization time; the API must not copy stale aircraft lists into tokens.
- A user may have multiple assignments. Effective permissions are the union of active, non-expired assignments.
- A deny is not needed in the first release. If deny rules become necessary, define precedence and conflict tests before adding them; do not invent intuitive precedence in the UI.
- Every assignment has an optional expiry. Temporary access is preferred for support and review work.
- Revocation is immediate at the authorization service and must invalidate or shorten relevant access tokens/session caches.
- A user cannot grant a role/scope broader than the administrator's own delegated scope.
- An administrator cannot grant themselves access through the UI.
- A suspended user has no effective permissions, even if assignments remain stored for audit history.

### 4.3 Stream-specific enforcement

The WebSocket server verifies the access token and the `telemetry:read`-equivalent stream permission at connection time. It then enforces aircraft/source restrictions from the server-resolved authorization context. Query parameters are filters, not grants. A client cannot widen a token's resource scope by changing `aircraft_id` or `source` in the WebSocket URL.

For the current reference stream, the JWT `telemetry:read`, `aircraft_ids`, and `sources` claims represent this future authorization result. The RBAC service should eventually issue short-lived tokens from the assignments above rather than letting clients mint or choose these claims.

## 5. UI information architecture

### Primary navigation

- **Fleet** — aircraft list, latest telemetry, source/environment and freshness.
- **Live Monitor** — live stream for authorized aircraft; prominent simulated/aircraft source label.
- **Maintenance** — read/write based on permission.
- **Access** — visible only with `users.read`, `roles.read`, or `assignments.read`.
- **Audit** — visible only with `audit.access.read` or broader approved audit permission.
- **Profile and sessions** — own profile, active sessions, sign-out/revoke own sessions.

The UI must hide navigation items only as a convenience. Backend authorization remains authoritative and returns a stable `403 forbidden` response with a safe error code.

## 6. Core screens

### 6.1 Access overview

Purpose: give an administrator a safe, searchable view of access posture.

```text
Access
[Users 42] [Active assignments 77] [Expiring in 7 days 4] [Suspended 2]

Search users or email [________________]  Status [All v]  Scope [All v]

Name              Status     Roles                         Scope           Expiry       Actions
A. Rivera          Active     Drone Operator                Fleet: Lab A     2026-10-24   View
J. Chen            Active     Telemetry Viewer              Aircraft: 001    —            View
M. Patel           Suspended  Access Administrator           Site: Test      —            View

[Invite user]
```

Required states: loading skeleton, empty organization, no search results, authorization denied, stale/failed request, and an explicit “simulation data” banner when the selected scope contains simulated aircraft.

### 6.2 User access detail

Purpose: answer “who is this user and exactly what can they see/do?”

```text
← Access / Users / J. Chen                         [Suspend user]

J. Chen                         Active
j.chen@example.test             Last sign-in: 12 min ago
MFA: enrolled                   Sessions: 2

Effective access
Permission                  Granted through                 Scope              Expiry
Telemetry latest read       Telemetry Viewer / assign-07    Aircraft: 001      —
Telemetry stream read       Telemetry Viewer / assign-07    Aircraft: 001      —
Maintenance read            Telemetry Viewer / assign-07    Aircraft: 001      —

Assignments                                      [+ Add assignment]
Telemetry Viewer   Aircraft: sim-ucas-001         Direct / Active        [Revoke]

Recent access changes                         [View audit]
...
```

The page separates **effective access** from **assignment records**. It shows inherited/derived scope, expiry, grantor, and reason. It never displays access tokens, JWTs, private keys, or password-reset secrets.

### 6.3 Invite user

Four-step flow:

1. **Identity:** email, display name, optional external identity/provider ID.
2. **Role:** choose one or more roles; show a plain-language permission summary.
3. **Scope:** choose organization/site/fleet/aircraft; search and preview affected aircraft.
4. **Review:** show role, every permission, scope, start/expiry, reason, inviter, and warning if access includes simulated or aircraft-sourced data.

Confirmation copy: “Granting this assignment allows the user to [permission summary] for [scope] until [expiry]. It does not grant aircraft control.”

### 6.4 Role catalog

Read-only in the first release. Each role card shows:

- role name and intended user;
- permission count;
- permission descriptions;
- whether the role can read live streams;
- maximum assignable scope for the current administrator;
- immutable system-role badge.

A future custom-role editor must include permission dependency warnings, impact preview, dual approval, versioning, and rollback. Do not ship an editable checkbox grid as the first role editor.

### 6.5 Assignment editor

The editor uses a staged “select role → select scope → set duration → review” flow. Changing role or scope invalidates the prior review step. The final screen includes a diff when modifying an existing assignment:

```text
Access change preview
- Removed: telemetry.history.read from Fleet: Lab A
+ Added: maintenance.write to Aircraft: sim-ucas-001
Expiry changed: 2026-10-24 → 2026-10-31

[Cancel] [Save and record audit event]
```

Destructive actions require typed confirmation for revoking an organization-wide assignment or suspending a user. Routine assignment revocation does not require a second confirmation if the review screen clearly states the exact scope and effect.

### 6.6 Audit view

Filters: actor, target user, action, role, scope, date range, result, request ID. The table shows metadata only:

```text
Time (UTC)        Actor       Action              Target       Scope         Result
2026-10-17 14:02  A. Rivera   assignment.created  J. Chen      Aircraft 001  Success
2026-10-17 13:55  Auth svc    login.failed        J. Chen      —             Denied
```

Audit detail includes before/after assignment state, reason, request ID, authentication method, and result. It excludes tokens, passwords, JWT payloads, private keys, raw authorization headers, and telemetry payloads unless a separately approved audit policy requires a reference.

## 7. Interaction and error rules

| Situation | UI behavior | API behavior |
|---|---|---|
| No permission to open Access | Hide navigation; direct route shows safe 403 page | Enforce permission server-side |
| User has no aircraft scope | Show empty authorized fleet, not an error | Return 200 with empty list for list reads |
| Assignment expired | Show `Expired` badge and effective-access removal | Deny protected resource; preserve assignment history |
| User suspended | Show suspension reason/status to admins | Deny all protected access; invalidate sessions |
| Scope changed while page is open | Show “Access changed; refresh required” | Re-evaluate on every request/token issuance |
| Save conflict | Preserve form and show version conflict | Require `If-Match`/version on assignment update |
| Bulk assignment too broad | Block before submission with impact preview | Enforce maximum delegated scope and policy limits |
| Stream token lacks aircraft scope | Do not connect or silently broaden | Close WebSocket with generic policy failure |
| Backend unavailable | Preserve last fetched data with timestamp; disable writes | Return retryable error; never fabricate access state |

## 8. API contract proposal

These are design contracts, not implemented endpoints yet.

```text
GET    /api/v1/access/users
POST   /api/v1/access/users/invitations
GET    /api/v1/access/users/{user_id}
POST   /api/v1/access/users/{user_id}/suspend
POST   /api/v1/access/users/{user_id}/reinstate
GET    /api/v1/access/roles
GET    /api/v1/access/permissions
GET    /api/v1/access/assignments
POST   /api/v1/access/assignments
PATCH  /api/v1/access/assignments/{assignment_id}
DELETE /api/v1/access/assignments/{assignment_id}
GET    /api/v1/access/effective/{user_id}
GET    /api/v1/audit/access
GET    /api/v1/sessions
DELETE /api/v1/sessions/{session_id}
```

Write requests require an idempotency key and `If-Match`/assignment version where applicable. Responses include `request_id`, canonical server timestamps, actor summary, and the resulting assignment version. Use stable error codes such as `forbidden`, `assignment_scope_exceeds_actor`, `assignment_expired`, `user_suspended`, `version_conflict`, and `role_immutable`.

The authorization service should expose a server-side decision function:

```text
authorize(subject, permission, resource_type, resource_id, request_context)
  -> {allowed, reason_code, assignment_ids, policy_version}
```

The UI may use `GET /effective/{user_id}` for explanation, but it must not make authorization decisions based on client-side role labels.

## 9. Audit and security requirements

- Audit assignment create/update/revoke, user invite/suspend/reinstate, role catalog changes, login failures, MFA changes, session revocation, and token issuance/revocation.
- Include actor, target, action, scope, before/after, timestamp, request ID, result, and policy version.
- Do not log bearer tokens, JWTs, passwords, private keys, raw authorization headers, or full telemetry payloads.
- Require MFA for Access Administrator and System Administrator accounts before access-policy writes.
- Use short-lived access tokens and refresh-token rotation; revoke sessions when a user is suspended or all assignments are removed.
- Use step-up authentication for organization-wide grants, suspension, and bulk access changes.
- Enforce server-side authorization on HTTP, WebSocket, export, and future MQTT/broker boundaries.
- Display UTC timestamps in audit views, with local-time rendering only as a secondary presentation.
- Include a visible environment/source label: `SIMULATED`, `LAB`, or `PRODUCTION`.

## 10. Acceptance criteria

1. A Telemetry Viewer can see only assigned aircraft’s latest/history/stream/evidence and cannot open Access administration.
2. A Drone Operator can read assigned telemetry and write maintenance/operational notes but cannot grant roles or access aircraft commands.
3. An Access Administrator can invite, assign, expire, revoke, suspend, and inspect effective access within delegated scope.
4. The UI previews exact permissions, resource scope, expiry, and simulation/aircraft source before every access grant.
5. Every access-policy mutation creates an audit event with no secrets or tokens.
6. Revocation and suspension prevent new API/WebSocket access and invalidate active sessions according to the session policy.
7. Concurrent assignment edits produce a version conflict rather than overwriting another administrator’s change.
8. Direct URL/API/WebSocket access cannot bypass UI-hidden permissions.
9. Unknown permissions and aircraft-control permissions are rejected by the API.
10. Empty, loading, stale, denied, expired, suspended, and backend-failure states are represented without relabeling cached telemetry as current.

## 11. Delivery phases

### Phase A — contract and read-only UI

Permission catalog, role catalog, user list, user effective-access view, audit read view, synthetic users/assignments, and authorization fixtures.

### Phase B — controlled writes

Invitations, assignment create/update/revoke, expiry, suspension, optimistic concurrency, audit events, and MFA/step-up integration.

### Phase C — live monitoring integration

Issue short-lived stream tokens from effective access, enforce aircraft/source scope at WebSocket/MQTT boundary, show connection/auth status, and test revocation during an active stream.

### Phase D — review before custom policy

Only after usage evidence: custom roles, delegated administration, bulk assignment, approval workflows, and policy simulation.
