# ADR 0342: Selected-text follow-up uses an ordinary session fork

- Status: Accepted
- Date: 2026-11-03
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: [ADR 0268](0268-remove-quotes-annotations-and-side-chats.md)
- Related: [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) ·
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)

## Context

ADR 0268 removed the selection overlay and renderer-owned side-chat lifecycle.
That decision remains correct: a second transcript projection and a docked
side-chat resource duplicated the ordinary child session already provided by
`session.fork`. However, copying a selected excerpt and manually creating a
branch does not preserve the user's focus in the new conversation.

## Decision

1. Add **Ask about selection** to the assistant-turn context menu only when a
   non-empty text selection belongs to that completed assistant turn. Do not
   offer it for user messages, an empty selection, a selection outside the
   right-clicked turn, or a turn that cannot be forked.
2. Selecting the action invokes the existing `session.fork` path anchored at
   the completed assistant response. The child is an ordinary durable session;
   it contains the source conversation through that response and is activated
   only while the fork still owns navigation.
3. When activated, initialize the child's normal Composer with a localized,
   editable prompt that quotes the selected excerpt. Do not submit it
   automatically. If a newer navigation supersedes the fork, record the child
   as usual but do not activate it or put text into another session's Composer.
4. Do not restore a selection toolbar, quote action, side-chat tab, independent
   transcript/stream projection, extra session lifecycle, IPC/RPC channel, or
   persisted selection state. Existing Fork remains unchanged.
5. Keep the selected-text follow-up scenario under a new E2E identifier. The
   retired side-chat E2E identifiers in ADR 0268 remain retired.

## Consequences

- The excerpt and its source answer are both available to the child: the fork
  carries the canonical conversation prefix, while the editable prompt makes
  the user's focus explicit.
- The source conversation is not edited, and the user remains in control of
  what is sent.
- This is a narrow follow-up to ADR 0268, not a reversal of its removal of
  side chats and annotations.
- No host protocol, database schema, permission, or extension contract changes.

## Alternatives considered

### Restore a docked side chat

Rejected: it recreates the parallel transcript, streaming, and cleanup
lifecycle that ADR 0268 removed, despite an ordinary session fork being durable
and independently addressable.

### Prefill the current conversation

Rejected: the selected text's source message would not be the boundary of an
independent context, and the user would have to manage the parent conversation's
existing draft.

### Copy only the excerpt

Rejected: a clipboard-only action loses the source conversation and requires
the user to create and populate the follow-up manually.
