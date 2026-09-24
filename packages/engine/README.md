# `@harness/engine`

This package owns Kira's current host-neutral tool bindings and application
registrations, grants, and capability composition for financial, Attachment,
and Document tools. `createEngineCapabilityRuntime` receives the existing
financial provider and Session-scoped stores, then returns the capability
Gateway and Judge plan used by the current CLI host.

Authority stays explicit: `@harness/capability` owns capability contracts,
`CapabilityRegistry`, `CapabilityPolicy`, `CapabilityGateway`, and the authorization
mechanism. `@harness/engine` owns application tool bindings, registrations, and
grants. `@harness/tool-runtime` remains execution authority. Domain packages
retain store, provider, and domain truth.

The engine does not create providers or databases, or own Judge workflows,
Session lifecycle, CLI events, or persistence.