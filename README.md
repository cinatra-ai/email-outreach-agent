# Email Outreach Agent

Run an outbound email campaign from scratch in one guided flow. The agent walks you through setting up the campaign, confirming recipients, picking drafting context, generating and reviewing personalized emails, choosing the sender, and configuring the trigger — pausing at every consequential step so nothing advances without your sign-off.

**Install:** find Email Outreach Agent in the Cinatra marketplace and add it to your workspace. It pulls in all required sub-agents automatically.

**Prerequisites:** connect a Gmail account via the Connections settings page before starting a campaign. You also need at least one saved contact list (use List Curator Agent or import from a CRM connector) so the recipient step has a source to pick from.

**Configuration:** when you launch a run, you supply a target company website URL, an optional sender name, and a call-to-action string. The drafting agent uses those three values to personalize each email. The sender email address is collected separately in the delivery step via the Gmail sender selector.

**Artifact context (optional):** attach marketing ICP, strategy, or product portfolio artifacts to the offering context slot before drafting. The drafting agent reads them to ground emails in your actual positioning.

**Troubleshooting:** if the recipient step returns zero contacts, verify that the selected list is non-empty and that the CRM connector is authorized. If delivery fails, check that the Gmail sender is connected and that the confirmed sender address matches an authorized Gmail account.

**Development:** the agent flow is defined in `cinatra/oas.json`. Run `node extension-kind-gate.mjs` at the repo root to validate the manifest and README locally before publishing.

## Works with

- Gmail

## Capabilities

- Set up a new outreach campaign with offering, sender, and call-to-action in one step
- Materialize the recipient list from a saved contact list and confirm it before drafting
- Recommend drafting skills and supporting context to ground every email
- Generate one personalized first-touch draft per recipient for review
- Approve every draft before the campaign advances to the sender step
- Confirm the sender address before the trigger is configured
- Configure the trigger that controls when the approved campaign should run
- Fail-safe: no email leaves without explicit human approval at every consequential gate
