/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: engine marks codicon does not have, as product icons. `$(dispatch-opencode)` is
 *  OpenCode's pixel "o" in one colour: a glyph of Dispatch's own icon font (media/dispatch-icons.ttf,
 *  drawn from media/opencode.svg by make-icon-font.py in the dispatch-ide repository), so it takes
 *  the text colour, size and baseline exactly like `$(claude)` and `$(openai)` next to it.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchEngineIcons.css';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';

/** OpenCode: the engine chip, session rows, Customizations and the account menu. */
export const openCodeIcon = registerIcon('dispatch-opencode', Codicon.circleLargeOutline, localize('dispatchOpenCodeIcon', "Icon for OpenCode."));
