/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// #######################################################################
// ###                                                                 ###
// ### !!! PLEASE ADD COMMON IMPORTS INTO WORKBENCH.COMMON.MAIN.TS !!! ###
// ###                                                                 ###
// #######################################################################

//#region --- workbench common

import './sessions.common.main.js';

//#endregion


//#region --- workbench (sessions desktop main)

import './electron-browser/sessions.main.js';
import '../workbench/electron-browser/desktop.contribution.js';

// Per-session layout controller (desktop / web desktop layout).
import './contrib/layout/browser/sessions.layout.contribution.js';

//#endregion


//#region --- workbench parts

import '../workbench/electron-browser/parts/dialogs/dialog.contribution.js';

//#endregion


//#region --- workbench services

import '../workbench/services/textfile/electron-browser/nativeTextFileService.js';
import '../workbench/services/dialogs/electron-browser/fileDialogService.js';
import '../workbench/services/workspaces/electron-browser/workspacesService.js';
import '../workbench/services/menubar/electron-browser/menubarService.js';
import '../workbench/services/update/electron-browser/updateService.js';
import '../workbench/services/url/electron-browser/urlService.js';
import '../workbench/services/lifecycle/electron-browser/lifecycleService.js';
import '../workbench/services/host/electron-browser/nativeHostService.js';
import './services/title/electron-browser/titleService.js';
import '../platform/meteredConnection/electron-browser/meteredConnectionService.js';
import '../workbench/services/request/electron-browser/requestService.js';
import '../workbench/services/clipboard/electron-browser/clipboardService.js';
import '../workbench/services/contextmenu/electron-browser/contextmenuService.js';
import '../workbench/services/configurationResolver/electron-browser/configurationResolverService.js';
import '../workbench/services/accessibility/electron-browser/accessibilityService.js';
import '../workbench/services/keybinding/electron-browser/nativeKeyboardLayout.js';
import '../workbench/services/path/electron-browser/pathService.js';
import '../workbench/services/themes/electron-browser/nativeHostColorSchemeService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionManagementService.js';
import '../workbench/services/mcp/electron-browser/mcpGalleryManifestService.js';
import '../workbench/services/mcp/electron-browser/mcpWorkbenchManagementService.js';
import '../workbench/services/encryption/electron-browser/encryptionService.js';
import '../workbench/services/imageResize/electron-browser/imageResizeService.js';
import '../workbench/services/secrets/electron-browser/secretStorageService.js';
import '../workbench/services/localization/electron-browser/languagePackService.js';
import '../workbench/services/telemetry/electron-browser/telemetryService.js';
import '../workbench/services/extensions/electron-browser/extensionHostStarter.js';
import '../platform/extensionResourceLoader/common/extensionResourceLoaderService.js';
import '../workbench/services/localization/electron-browser/localeService.js';
import '../workbench/services/extensions/electron-browser/extensionsScannerService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionManagementServerService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionGalleryManifestService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionGalleryAccountService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionTipsService.js';
import '../workbench/services/userDataSync/electron-browser/userDataSyncService.js';
import '../workbench/services/userDataSync/electron-browser/userDataAutoSyncService.js';
import '../workbench/contrib/userDataSync/electron-browser/userDataSyncUtilChannel.contribution.js';
import '../workbench/services/timer/electron-browser/timerService.js';
import '../workbench/services/environment/electron-browser/shellEnvironmentService.js';
import '../workbench/services/integrity/electron-browser/integrityService.js';
import '../workbench/services/workingCopy/electron-browser/workingCopyBackupService.js';
import '../workbench/services/checksum/electron-browser/checksumService.js';
import '../platform/remote/electron-browser/sharedProcessTunnelService.js';
import '../workbench/services/tunnel/electron-browser/tunnelService.js';
import '../platform/diagnostics/electron-browser/diagnosticsService.js';
import '../platform/profiling/electron-browser/profilingService.js';
import '../platform/telemetry/electron-browser/customEndpointTelemetryService.js';
import '../platform/remoteTunnel/electron-browser/remoteTunnelService.js';
import '../workbench/services/files/electron-browser/elevatedFileService.js';
import '../workbench/services/search/electron-browser/searchService.js';
import '../workbench/services/workingCopy/electron-browser/workingCopyHistoryService.js';
import '../workbench/services/userDataSync/browser/userDataSyncEnablementService.js';
import '../workbench/services/extensions/electron-browser/nativeExtensionService.js';
import '../platform/userDataProfile/electron-browser/userDataProfileStorageService.js';
import '../workbench/services/auxiliaryWindow/electron-browser/auxiliaryWindowService.js';
import '../platform/extensionManagement/electron-browser/extensionsProfileScannerService.js';
import '../platform/sandbox/electron-browser/sandboxHelperService.js';
import '../platform/webContentExtractor/electron-browser/webContentExtractorService.js';
import '../workbench/services/browserView/electron-browser/playwrightWorkbenchService.js';
import '../workbench/services/process/electron-browser/processService.js';
import '../workbench/services/power/electron-browser/powerService.js';
import '../workbench/services/localTranscription/electron-browser/localTranscriptionService.js';
import './contrib/automations/electron-browser/automationStorageService.js';

import { ILocalGitService } from '../platform/git/common/localGitService.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IRemoteAgentHostService } from '../platform/agentHost/common/remoteAgentHostService.js';
import { AgentsWindowRemoteAgentHostService } from '../platform/agentHost/browser/remoteAgentHostServiceImpl.js';
import { IRemoteAgentHostLocationPreferenceService } from '../platform/agentHost/common/remoteAgentHostLocationPreference.js';
import { RemoteAgentHostLocationPreferenceService } from '../platform/agentHost/browser/remoteAgentHostLocationPreferenceService.js';
import { ISSHHostKeyTrustService } from '../platform/agentHost/common/sshHostKeyTrust.js';
import { SSHHostKeyTrustService } from '../platform/agentHost/browser/sshHostKeyTrustService.js';
import { registerSharedProcessRemoteService } from '../platform/ipc/electron-browser/services.js';
import { IPluginGitService } from '../workbench/contrib/chat/common/plugins/pluginGitService.js';
import { NativePluginGitCommandService } from '../workbench/contrib/chat/electron-browser/pluginGitCommandService.js';
import { IUserDataInitializationService, UserDataInitializationService } from '../workbench/services/userData/browser/userDataInit.js';
import { SyncDescriptor } from '../platform/instantiation/common/descriptors.js';

registerSingleton(IUserDataInitializationService, new SyncDescriptor(UserDataInitializationService, [[]], true));

// Override the browser PluginGitCommandService with the native one that always
// runs git locally via the shared process.
registerSingleton(IPluginGitService, NativePluginGitCommandService, InstantiationType.Delayed);
registerSingleton(IRemoteAgentHostService, AgentsWindowRemoteAgentHostService, InstantiationType.Delayed);
registerSingleton(IRemoteAgentHostLocationPreferenceService, RemoteAgentHostLocationPreferenceService, InstantiationType.Delayed);
registerSingleton(ISSHHostKeyTrustService, SSHHostKeyTrustService, InstantiationType.Delayed);
registerSharedProcessRemoteService(ILocalGitService, 'localGit');


//#endregion


//#region --- workbench contributions

// Logs
import '../workbench/contrib/logs/electron-browser/logs.contribution.js';

// Localizations
import '../workbench/contrib/localization/electron-browser/localization.contribution.js';

// Explorer
import '../workbench/contrib/files/electron-browser/fileActions.contribution.js';

// CodeEditor Contributions
import '../workbench/contrib/codeEditor/electron-browser/codeEditor.contribution.js';

// Debug
import '../workbench/contrib/debug/electron-browser/extensionHostDebugService.js';

// Extension devtools
import '../workbench/contrib/extensions/electron-browser/devtoolsExtensionHost.contribution.js';

// Extensions Management (runtime extensions editor, profiling, remote extensions, etc.)
import '../workbench/contrib/extensions/electron-browser/extensions.contribution.js';


// Issues
import '../workbench/contrib/issue/electron-browser/issue.contribution.js';

// Surveys
import '../workbench/contrib/surveys/browser/survey.contribution.js';

// Process Explorer
import '../workbench/contrib/processExplorer/electron-browser/processExplorer.contribution.js';

// Remote
import '../workbench/contrib/remote/electron-browser/remote.contribution.js';

// Terminal
import '../workbench/contrib/terminal/electron-browser/terminal.contribution.js';

// Themes
import '../workbench/contrib/themes/browser/themes.test.contribution.js';
import '../workbench/services/themes/electron-browser/themes.contribution.js';
// Tags
import '../workbench/contrib/tags/electron-browser/workspaceTagsService.js';
import '../workbench/contrib/tags/electron-browser/tags.contribution.js';
// Performance
import '../workbench/contrib/performance/electron-browser/performance.contribution.js';

// Tasks
import '../workbench/contrib/tasks/electron-browser/taskService.js';

// External terminal
import '../workbench/contrib/externalTerminal/electron-browser/externalTerminal.contribution.js';

// Webview
import '../workbench/contrib/webview/electron-browser/webview.contribution.js';

// Browser
import '../workbench/contrib/browserView/electron-browser/browserView.contribution.js';

// Splash
import '../workbench/contrib/splash/electron-browser/splash.contribution.js';

// Local History
import '../workbench/contrib/localHistory/electron-browser/localHistory.contribution.js';

// Merge Editor
import '../workbench/contrib/mergeEditor/electron-browser/mergeEditor.contribution.js';

// Multi Diff Editor
import '../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js';

// Remote Tunnel
import '../workbench/contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.js';

// Encryption
import '../workbench/contrib/encryption/electron-browser/encryption.contribution.js';

// Emergency Alert
import '../workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.js';

// MCP
import '../workbench/contrib/mcp/electron-browser/mcp.contribution.js';

// Policy Export
import '../workbench/contrib/policyExport/electron-browser/policyExport.contribution.js';

// Keybindings Export
import '../workbench/contrib/keybindingsExport/electron-browser/keybindingsExport.contribution.js';

//#endregion


//#region --- sessions contributions

import './electron-browser/sessions.desktop.contribution.js';

// Remote Agent Host
import '../workbench/services/agentHost/electron-browser/agentHostService.js';
import '../platform/agentHost/electron-browser/sshRemoteAgentHostService.js';
import '../platform/agentHost/electron-browser/wslRemoteAgentHostService.js';
import './contrib/providers/remoteAgentHost/electron-browser/tunnelAgentHostService.js';
import './contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.js';
import './contrib/providers/remoteAgentHost/browser/remoteAgentHostTerminal.contribution.js';
import './contrib/providers/remoteAgentHost/browser/tunnelAgentHost.contribution.js';
import './contrib/providers/remoteAgentHost/browser/wslAgentHost.contribution.js';
import './contrib/providers/remoteAgentHost/browser/sshAgentHost.contribution.js';
import './contrib/providers/remoteAgentHost/browser/webSocketAgentHost.contribution.js';
import './contrib/providers/remoteAgentHost/browser/devContainerAgentHostService.js';
import './contrib/providers/remoteAgentHost/electron-browser/devContainerAgentHostConnector.contribution.js';
// Change Preferred Remote Agent Location (Chat: ... command)
import './contrib/providers/remoteAgentHost/electron-browser/remoteAgentHostLocationPreferenceCommand.js';
import './contrib/providers/remoteAgentHost/electron-browser/forgetSSHHostKeyCommand.js';
// Copilot cloud sandbox connections (copilot-developer-cli) over a Web PubSub AHP relay
import './contrib/providers/remoteAgentHost/browser/cloudSandboxAgentHost.contribution.js';
// Chat
import './contrib/agentFeedback/browser/agentFeedback.contribution.js';
import './contrib/chat/electron-browser/chat.contribution.js';
// Dispatch IDE: drawing boxes on a picture before asking, in the input, the side pane and on a page (patches/320-draw-and-ask.patch)
import './contrib/dispatchDraw/browser/dispatchDraw.contribution.js';
import './contrib/dispatchDraw/electron-browser/dispatchDrawBrowser.js';

// Local Agent Host
import './contrib/providers/agentHost/browser/localAgentHost.contribution.js';
import './contrib/providers/agentHost/electron-browser/localAgentHostLifecycle.contribution.js';
import './contrib/providers/agentHost/browser/agentSessionSettings.contribution.js';
import './contrib/providers/agentHost/browser/agentHostSettings.contribution.js';
import './contrib/providers/agentHost/browser/agentHostSessionBranchActions.js';
import './contrib/providers/agentHost/browser/agentMergeActions.js';
import './contrib/providers/agentHost/browser/agentHostSkillButtons.js';
import './contrib/providers/agentHost/browser/openSubagentChat.js';
import './contrib/providers/agentHost/electron-browser/agentHost.contribution.js';
// Dispatch IDE: the harness chip of a running session switches Claude / Codex through dispatch-bridge
import './contrib/providers/agentHost/browser/dispatchHarnessPicker.js';

// Tunnel Host (allow remote connections to local agent host)
import './contrib/tunnelHost/electron-browser/tunnelHost.contribution.js';

// Sessions (desktop only)
import './contrib/sessions/electron-browser/sessions.contribution.js';
// Dispatch IDE: Dispatch's block symbols and seven motions, shared by every page (patches/050-blocks.patch)
import './contrib/dispatchBlocks/browser/dispatchBlocks.contribution.js';
// Dispatch IDE: the input box in Dispatch's blocks (patches/305-composer.patch)
import './contrib/dispatchComposer/browser/dispatchComposer.contribution.js';
// Dispatch IDE: the Now tab, first in a session's side pane (patches/410-now.patch)
import './contrib/dispatchNow/browser/dispatchNow.contribution.js';
// Dispatch IDE: the sub-agents at work, in a strip above the message box (direction A, task-1rzdr)
import './contrib/dispatchSubagents/browser/dispatchSubagents.contribution.js';
// Dispatch IDE: what is asked for in a chat goes on the board by itself and lines up (patches/415-next-up.patch)
import './contrib/dispatchCapture/browser/dispatchCapture.contribution.js';
// Dispatch IDE: the Docs tab and the open-path commands the chat's path links use
import './contrib/dispatchDocs/browser/dispatchDocs.contribution.js';
// Dispatch IDE: side chats open in a card in the side pane's bottom right corner (contrib/dispatchSideChat, task-23iin)
import './contrib/dispatchSideChat/browser/dispatchSideChat.contribution.js';
// Dispatch IDE: learning while the agent works: Talk's small cards, Quiet or Talk, Ask Question on the terminal (contrib/dispatchLearn, task-q9x2r)
import './contrib/dispatchLearn/browser/dispatchLearn.contribution.js';
// Dispatch IDE: the Tasks tab, the task graph and the task page (patches/430-tasks.patch, 430-tasks.patch)
import './contrib/dispatchTasks/browser/dispatchTasks.contribution.js';
import './contrib/dispatchTaskGraph/browser/dispatchTaskGraph.contribution.js';
// Dispatch IDE: the History tab, every agent session on this Mac without importing any (patches/450-history.patch)
import './contrib/dispatchHistory/browser/dispatchHistory.contribution.js';
// Dispatch IDE: What's new after an update: NEW next to new entry points, the card at the top left (patches/480-whats-new.patch)
import './contrib/dispatchWhatsNew/browser/dispatchWhatsNew.contribution.js';
// Dispatch IDE: tips that point at the real thing and the Getting started checklist (patches/475-tours.patch)
import './contrib/dispatchTours/browser/dispatchTours.contribution.js';
// Dispatch IDE: "Let the agent fix it" and the agent-written commit message in the Changes tab (patches/dispatch-fixit.patch)
import './contrib/dispatchFixit/browser/dispatchFixit.contribution.js';
// Dispatch IDE: the side pane's tabs switch on a click on their name and fit a narrow pane (contrib/dispatchTabs)
import './contrib/dispatchTabs/browser/dispatchTabs.contribution.js';

//#endregion

// Dispatch IDE: radii, row heights, column width and input shapes from Dispatch's DESIGN.md (last, so it wins)
import './browser/media/dispatch-shell.css';

export { main } from './electron-browser/sessions.main.js';

import './contrib/dispatchOnboarding/browser/dispatchOnboarding.contribution.js';
import './contrib/dispatchAddProject/browser/dispatchAddProject.contribution.js';
import './contrib/dispatchProjectCustom/browser/dispatchProjectCustom.js';
// Dispatch IDE: usage of the accounts in use in the title bar, several accounts switched in one step (patches/290-accounts.patch)
import './contrib/dispatchAccounts/browser/dispatchAccounts.contribution.js';
// Dispatch IDE: the bell in the title bar and the Dock number (kanban task-gfhy)
import './contrib/dispatchInbox/electron-browser/dispatchInbox.contribution.js';
// Dispatch IDE: the bottom bar, status in blocks: builds, keep awake, allowance (patches/120-status-bar.patch)
import './contrib/dispatchStatusBar/browser/dispatchStatusBar.contribution.js';
// Dispatch IDE: Editor first of the icons at the top right, New's capsule
import './contrib/dispatchTitleBar/browser/dispatchEditorEntry.js';
// Dispatch IDE: "folder › session" in the title bar, its menu on a click (patches/110-title-bar.patch)
import './contrib/dispatchTitleBar/browser/dispatchPlace.js';
// Dispatch IDE: Motion Less, decoration stops (patches/055-motion-setting.patch)
import '../workbench/contrib/dispatchMotion/browser/dispatchMotion.contribution.js';
// Dispatch IDE: F1 and ⇧⌘P over a modal editor such as Settings (patches/075-modal-palette.patch)
import '../workbench/contrib/dispatchModalPalette/browser/dispatchModalPalette.contribution.js';
// Dispatch IDE: what you type and save in the editor counts as yours in who wrote which line (task-m6hek)
import '../workbench/contrib/dispatchEditorEdits/browser/dispatchEditorEdits.contribution.js';
// Dispatch IDE: Turbo, a big job in parts at the same time, and the Assistant's Timeline tab (patches/420-turbo.patch)
import './contrib/dispatchTurbo/browser/dispatchTurbo.contribution.js';
