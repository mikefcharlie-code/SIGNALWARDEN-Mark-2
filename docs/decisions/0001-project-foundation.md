# ADR-0001: Private monorepo and simulation-first foundation

**Status:** provisional organizing default; owner review pending.

## Context

The owner requested a repository and initial organization for a UCAS drone and management system, without selecting platform, stack, or deployment.

## Choice

Use one private repository with separated hardware, firmware, management, contracts, simulation, infrastructure, and operations areas. Begin with shared contracts and offline synthetic examples. Keep stack/platform decisions open.

## Alternatives

Separate repositories could isolate releases but add early interface coordination. Selecting a complete stack immediately would accelerate scaffolding but risks choosing against unknown requirements.

## Consequences

Cross-component documentation and contract changes remain traceable in one place. Component READMEs clearly state placeholders. Revisit repository boundaries when ownership and independent release needs are known. Python is tooling only; no management application stack is committed.
