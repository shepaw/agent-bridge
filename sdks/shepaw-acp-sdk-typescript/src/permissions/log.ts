/**
 * Shared logging for SDK-level permission modules.
 *
 * Uses the `debug` package under the `shepaw:gateway` namespace, so
 * existing `DEBUG=shepaw:gateway` environment variable setups keep working
 * after the permission modules moved from implementations into the SDK.
 */

import createDebug from 'debug';

const gateway = createDebug('shepaw:gateway');

export const log = {
  gateway,
};
