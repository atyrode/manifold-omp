/**
 * Model ids for the gateway's live-catalog cases.
 *
 * What those assertions are about is a SHAPE of name, never which model wore it: an id the
 * provider lists and the pinned SDK snapshot never carried, and the double-qualified form the
 * gateway's own publishing produces from it. They were written against a real withdrawn
 * OpenRouter stealth id, which sent the next reader searching a provider listing for something
 * that no longer exists — and, while it did exist, tied the tests to one vendor's unlisted
 * release rather than to the mechanism.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so no published id at any provider
 * can collide with these and nobody can mistake them for a name to look up.
 */

/** An id a provider's live listing carries and the bundled catalog does not. */
export const UNLISTED_MODEL_ID = "example.invalid/unlisted-alpha";

/** That model as this gateway publishes it: the provider's own prefix and nothing else. */
export const UNLISTED_PUBLISHED_ID = `openrouter/${UNLISTED_MODEL_ID}`;

/** An id no listing carries at all, for the cases that must refuse rather than resolve. */
export const ABSENT_MODEL_ID = "example.invalid/no-such-model";
