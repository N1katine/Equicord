/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { ScreenshareIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { User } from "@vencord/discord-types";
import { FluxDispatcher, Menu, SelectedChannelStore } from "@webpack/common";

import { activeP2PStreams, getActiveP2PStream, getGoLiveSource, getP2PStream, interceptStreamActions, isActiveP2PKey, isLive, isP2PStream, isPreexistingLive, liveOwnersIn, myStream, onVoiceChannel, p2pRoute, P2PStore, p2pViewerIds, stopStream, stopWatcher, unwatchSelected, useP2P, usePreview, useStreaming, useWatchingIn } from "./net";
import { renderTile, startWatching } from "./ui";

const userContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || !isLive(user.id)) return;
    children.push(<Menu.MenuItem id="vc-p2p-watch" label="Watch Stream" icon={ScreenshareIcon} action={() => startWatching(user.id)} />);
};

export default definePlugin({
    name: "P2PScreenShare",
    description: "Streams your screen directly to people in the same call, without going through Discord's Go Live.",
    tags: ["Media", "Voice"],
    authors: [EquicordDevs.N1katine],

    patches: [
        {
            find: "VOICE_PANEL}}",
            replacement: [
                {
                    match: /(?<=user:(\i),[^}]{0,80}\}=\i;)if\(\i\|\|\i\)return null;/,
                    replace: "let vcP2P=$self.useP2P($1.id);$&"
                },
                {
                    match: /(\i)(&&\i\.push\(\(0,\i\.jsx\)\(\i\.\i,\{size:\i\.\i\.Sizes\.SMALL\},"stream"\)\))/,
                    replace: "(vcP2P.live||$1)$2"
                },
                {
                    match: /(\i)(&&\i\.push\(\(0,\i\.jsx\)\(\i\.\i,\{text:[^{}]{0,60},children:\(0,\i\.jsx\)\(\i\.EyeIcon,)/,
                    replace: "(vcP2P.watching||$1)$2"
                }
            ]
        },
        {
            find: 'location:"VoiceUserPopout"',
            replacement: {
                match: /(\(\)=>)(\i\.\i\.getStreamForUser\((\i)\.id,(\i)\.getGuildId\(\)\))/,
                replace: "$1$self.getP2PStream($3.id,$4.id)??$2"
            }
        },
        {
            find: /onWatchStream:\i\?\i:void 0/,
            replacement: [
                {
                    match: /(function \i\(\)\{)(if\(!\i\|\|!\(0,\i\.\i\)\([^;]{0,60}\)\[0\]\)return;let \i=\{streamType:\i\.\i\.GUILD,ownerId:(\i)\.id)/,
                    replace: "$1if($self.startWatching($3.id))return;$2"
                },
                {
                    match: /onWatchStream:(\i)\?(\i):void 0/,
                    replace: "onWatchStream:$1||$self.isLive(arguments[0].user.id)?$2:void 0"
                }
            ]
        },
        {
            find: /\{previewUrl:\i,isLoading:\i\}=\(0,\i\.\i\)\(\i\.guildId,\i\.channelId,\i\.ownerId\)/,
            replacement: {
                match: /\{previewUrl:(\i),isLoading:(\i)\}=\(0,(\i\.\i)\)\((\i)\.guildId,\i\.channelId,\i\.ownerId\)/,
                replace: "{previewUrl:$1,isLoading:$2}=$self.usePreview($4,(0,$3)($4.guildId,$self.isP2PStream($4)?null:$4.channelId,$4.ownerId))"
            }
        },
        {
            find: '"__EMBEDDED_ACTIVITIES__"',
            replacement: {
                match: /let (\i)=(\i\.\i\.getStreamForUser\((\i),(\i)\)\?\?\i\.\i\.getActiveStreamForUser\(\3,\4\));if\((\i\.\i\.supports\(\i\.\i\.VIDEO\))&&null!=\1/,
                replace: "let $1=$self.getP2PStream($3,this.channelId)??$2;if(($self.isP2PStream($1)||$5)&&null!=$1"
            }
        },
        {
            find: 'displayName="ChannelRTCStore"',
            replacement: [
                {
                    match: /(RTC_CONNECTION_VIDEO:)(function\(\i\)\{let\{channelId:\i,userId:\i\}=\i;return \i\(\i,\[\i\]\)\})/,
                    replace: "VC_P2P_UPDATE:$2,$1$2"
                },
                {
                    match: /(\i\.\i)\.getActiveStreamForStreamKey\((\i)\.id\)/g,
                    replace: "($self.isActiveP2PKey($2.id)||$1.getActiveStreamForStreamKey($2.id))"
                }
            ]
        },
        {
            find: "Stream Tile State - activeStream:",
            replacement: [
                {
                    match: /(if\(\i\?\.state===\i\.\i\.ENDED\)return\(0,\i\.jsx\)\((\i\.\i),\{selected:)/,
                    replace: "{let vcP2PTile=$self.renderTile(arguments[0],$2);if(vcP2PTile)return vcP2PTile}$1"
                },
                {
                    match: /(\i=\(0,\i\.\i\)\(\[\i\.\i\],\(\)=>)(\i\.\i\.getActiveStreamForUser\((\i)\.user\.id,\3\.stream\.guildId\))/,
                    replace: "$1$self.getActiveP2PStream($3)??$2"
                }
            ]
        },
        {
            find: '"CenterControlTray"',
            replacement: [
                {
                    match: /(\i)=(\i\?\.type===\i\.\i\.STREAM&&null!=\i&&\i\.ownerId!==\i\?\.id)(?=,\i=\(0,\i\.\i\)\(\[\i\.\i\],\(\)=>\i\.\i\.getAllActiveStreamsForChannel\((\i)\.id\))/,
                    replace: "$1=$self.useWatchingIn($3.id)||$2"
                },
                {
                    match: /(\i\.useCallback\(\(\)=>\{)(if\(null!=\i\)\(0,\i\.\i\)\(\(0,\i\.\i\)\(\i\)\);else for\(let \i of \i\))/,
                    replace: "$1if($self.unwatchSelected())return;$2"
                },
                {
                    match: /canGoLive:(\i)(,hasPermission:\i,videoBlocked:\i=!1,disabled:\i\}=\i,)/,
                    replace: "canGoLive:vcP2PCanGoLive$2$1=vcP2PCanGoLive||$self.p2pRoute(),vcP2PStreaming=$self.useStreaming(),"
                },
                {
                    match: /if\(!(\(0,\i\.\i\)\(\[\i\.\i\],\(\)=>\i\.\i\.supports\(\i\.\i\.VIDEO\)\))\)return null;(?=function \i\(\)\{\(\(0,\i\.\i\)\(\i,\i\.\i\.STREAM,!0\))/,
                    replace: "if(!($1||$self.p2pRoute()))return null;"
                },
                {
                    match: /activeStreams:null!=(\i)\?\[\1\]:\[\]/,
                    replace: "activeStreams:null!=$1?[$1]:vcP2PStreaming?[$self.myStream()]:[]"
                },
                {
                    match: /(\i)=(null!=\i;return\(0,\i\.jsx\)\(\i\.\i,\{\.\.\.\i,centerButton:!0)/,
                    replace: "$1=vcP2PStreaming||$2"
                },
                {
                    match: /streamActive:(null!=\i),videoBlocked:\i,isSelfStream:!0/,
                    replace: "streamActive:vcP2PStreaming||$1,videoBlocked:!1,isSelfStream:!0"
                },
                {
                    match: /onClick:null!=(\i)\?(\i):(\i)(?=\}\)\}\(\i,\i\))/,
                    replace: "onClick:null!=$1?$2:vcP2PStreaming?$self.stopStream:$3"
                }
            ]
        },
        {
            find: 'useConfig({location:"RTCConnection"})',
            replacement: [
                {
                    match: /(\{channel:\i,canGoLive:)(\i)(,enableActivities:\i,disabled:\i\}=\i,)/,
                    replace: "$1vcP2PCanGoLive$3$2=vcP2PCanGoLive||$self.p2pRoute(),"
                },
                {
                    match: /(\i)=!(\i\.\i\.useConfig\(\{location:"RTCConnection"\}\)\.videoEnabled)(?=,\i=\i\.useCallback\(\(\)=>\{\(0,\i\.\i\)\(\i,\i\.id,\i\)\})/,
                    replace: "vcP2PStreaming=$self.useStreaming(),$1=($2,!1)"
                },
                {
                    match: /(\i=null==\i\?\i\?\i:\i\.\i:\(\)=>\(0,\i\.\i\)\(\i\);let \i=)(null!=\i\|\|\i\.length>0)/,
                    replace: "$1vcP2PStreaming||$2"
                },
                {
                    match: /(\i)=(null!=\i),(\{Component:\i,events:\i,play:\i\})/,
                    replace: "$1=vcP2PStreaming||$2,$3"
                },
                {
                    match: /(renderPopout:\i=>\{let\{closePopout:\i\}=\i;return\(0,\i\.jsx\)\(\i\.\i,\{channel:\i,currentUser:\i,activeStreams:)(\i)(?=,onClose:)/,
                    replace: "$1vcP2PStreaming?[...$2,$self.myStream()]:$2"
                },
                {
                    match: /("aria-pressed":)(null!=\i)/,
                    replace: "$1vcP2PStreaming||$2"
                },
                {
                    match: /(\{\[\i\.\i\]:)(null!=\i)(,\[\i\.\i\]:!\i\|\|\i\}\))/,
                    replace: "$1vcP2PStreaming||$2$3"
                }
            ]
        },
        {
            find: '"stream-settings-fps"',
            replacement: [
                {
                    match: /(\i\.\i)\.getGoLiveSource\(\)/g,
                    replace: "($self.getGoLiveSource()??$1.getGoLiveSource())"
                },
                {
                    match: /(let \i=)(\i\.isPlatformEmbedded\?\(0,\i\.jsx\)\(\i\.\i,\{id:"stream-settings",)/,
                    replace: "$1!$self.isP2PStream(arguments[0].stream)&&$2"
                }
            ]
        },
        {
            find: 'navId:"manage-streams"',
            replacement: {
                match: /(\i)=\(0,(\i\.\i)\)\((\i),(\i)\)(?=,\i=\(0,\i\.\i\)\(\{disableChangeWindows:)/,
                replace: "$1=(0,$2)($self.isP2PStream($3)?null:$3,$4)"
            }
        },
        {
            find: 'location:"canStreamWithSettings"',
            replacement: {
                match: /(function \i\(\i,\i,\i,\i,\i,\i\)\{)(?=if\(\i===\i\.\i\.PRESET_AUTO\))/,
                replace: "$1if($self.p2pRoute())return!0;"
            }
        },
        {
            find: 'return"stream_user_left"',
            replacement: [
                {
                    match: /\[(\i\.\i,\i\.\i,\i\.default,\i\.\i,\i\.\i,\i\.\i\],\(\)=>\{let \i,\i,\i=\i\.\i\.getVoiceChannelId\(\),\i=\i\.default\.getId\(\),\i=\[\],\i=null,\i=0,\i=!1,\i=\[\],\i=\i\.\i\.getAllActiveStreams\(\))/,
                    replace: "[$self.P2PStore,$1.concat($self.activeP2PStreams())"
                },
                {
                    match: /(isInChannel\(\i\.id\),\i=\i\.\i\.getAllApplicationStreamsForChannel\((\i)\.id\)\.map\(\i=>\i\.ownerId\))/,
                    replace: "$1.concat($self.liveOwnersIn($2.id))"
                },
                {
                    match: /(1===(\i)\.length\?\2\[0\]:)(\i\.\i\.getCurrentUserActiveStream\(\))/,
                    replace: "$1($3??$self.myStream())"
                },
                {
                    match: /(\i=)(\i\.\i)\.getViewerIds\((\i)\)(?=\.filter\(\i=>\i!==\i\)\.length\),\{channelType:)/,
                    replace: "$1($self.p2pViewerIds($3)??$2.getViewerIds($3))"
                },
                {
                    match: /(\i\.some\((\i)=>!\i\.streamingUserIds\.includes\(\2\))/,
                    replace: "$1&&!$self.isPreexistingLive($2)"
                }
            ]
        }
    ],

    useP2P,
    isLive,
    usePreview,
    useStreaming,
    useWatchingIn,
    unwatchSelected,
    stopStream,
    myStream,
    getGoLiveSource,
    isP2PStream,
    p2pRoute,
    startWatching,
    getP2PStream,
    getActiveP2PStream,
    isActiveP2PKey,
    renderTile,
    P2PStore,
    activeP2PStreams,
    liveOwnersIn,
    p2pViewerIds,
    isPreexistingLive,

    contextMenus: {
        "user-context": userContext
    },

    flux: {
        VOICE_CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            onVoiceChannel(channelId);
        }
    },

    start() {
        FluxDispatcher.addInterceptor(interceptStreamActions);
        onVoiceChannel(SelectedChannelStore.getVoiceChannelId() ?? null);
    },

    stop() {
        const index = FluxDispatcher._interceptors.indexOf(interceptStreamActions);
        if (index !== -1) FluxDispatcher._interceptors.splice(index, 1);
        stopStream();
        stopWatcher();
    }
});
