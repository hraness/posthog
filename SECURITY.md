# Security

Report vulnerabilities privately through the repository's GitHub security advisory page. Do not open a public issue for an undisclosed vulnerability.

Public `phc_` project tokens are analytics routing identifiers, not authorization credentials. Personal `phx_` API keys remain build-time secrets and must never reach a browser bundle, logged payload, fixture, or repository. Applications must make authorization and routing decisions from trusted server-side state rather than analytics properties.

Security fixes are supported on the latest release. Include affected versions, reproduction conditions, and impact in a report. Do not include live credentials or private deployment data.
