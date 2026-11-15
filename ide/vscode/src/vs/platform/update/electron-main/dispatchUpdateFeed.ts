/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the update feed is a static folder written by release.sh, not an update server
 *  (015-update-feed.patch). updateService.darwin.ts asks dispatchFeedHasUpdate before it hands the feed to Electron.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { IUpdate } from '../common/update.js';
import { getUpdateRequestHeaders } from './abstractUpdateService.js';

/** True when the feed answers with an update (`url` and `version`); 204, 404, `{}` are none. */
export async function dispatchFeedHasUpdate(requestService: IRequestService, productService: IProductService, logService: ILogService, url: string): Promise<boolean> {
	try {
		const context = await requestService.request({ url, headers: getUpdateRequestHeaders(productService.version), callSite: 'updateService.darwin.feedHasUpdate' }, CancellationToken.None);
		if (context.res.statusCode !== 200) {
			logService.trace('update#feedHasUpdate - no update', { statusCode: context.res.statusCode });
			return false;
		}
		const update = await asJson<IUpdate>(context);
		return !!update?.url && !!update.version;
	} catch (err) {
		logService.error('update#feedHasUpdate - failed to read the update feed', err);
		return false;
	}
}
