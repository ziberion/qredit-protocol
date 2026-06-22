# Security

## Internal Security Review

An internal security review was conducted prior to testnet deployment (June 2026).

### High Severity — Resolved

| ID | Title | Status |
|---|---|---|
| ALTO-01 | Oracle price not refreshed atomically before mint | ✅ Resolved — explicit `_freshPrice()` call added in `mintBacked` |
| ALTO-02 | Oracle staleness not enforced on fallback path | ✅ Resolved — staleness check added to all fallback branches |

### Medium Severity — Resolved

| ID | Title | Status |
|---|---|---|
| MEDIO-01 | No upper bound on reserve asset list (DoS via gas) | ✅ Resolved — `MAX_RESERVE_ASSETS = 20` enforced |
| MEDIO-02 | Transfer fee applied to fee-exempt addresses | ✅ Resolved — `feeExempt` check added in `_update` |
| MEDIO-03 | Circuit breaker required manual reset after normalization | ✅ Resolved — auto-reset when price returns within range |
| MEDIO-04 | Role assignment revocation did not emit event | ✅ Resolved — event emission added |
| MEDIO-05 | Governance state updated before execution (could leave proposal in wrong state on revert) | ✅ Resolved — execution precedes state update |

### Known Limitations (Pre-Mainnet)

| ID | Title | Severity | Notes |
|---|---|---|---|
| PRE-01 | Governance voting power uses live balance, not snapshot | High | Flash loan attack vector. Mitigation: migrate to `ERC20Votes` before mainnet |
| PRE-02 | `UPDATE_BASKET_WEIGHTS` proposal type missing execution branch | Medium | Approved proposals of this type execute silently without effect |
| PRE-03 | `proposalThreshold` not updatable via governance | Low | Requires contract upgrade to change |
| PRE-04 | Delegated voting power not updated on token transfer | Medium | Resolved by migrating to `ERC20Votes` (see PRE-01) |

## External Audit

An external smart contract audit is planned prior to mainnet deployment. The audit scope will cover all four primary contracts, the oracle aggregation logic, and the governance execution pathway.

## Automated Security Scanning

Slither and Mythril integration into CI/CD is planned for the testnet phase.

## Responsible Disclosure

Please report vulnerabilities to **security@qredits.io** before opening a public issue. We aim to respond within 48 hours.
