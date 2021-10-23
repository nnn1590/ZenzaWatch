import {netUtil} from '../infra/netUtil';
import {textUtil} from '../text/textUtil';
import {nicoUtil} from '../nico/nicoUtil';
import {Emitter} from '../Emitter';
import {CacheStorage} from '../infra/CacheStorage';

const Config = {
  getValue: () => {}
};

const emitter = new Emitter();
const debug = {};

//===BEGIN===
const VideoInfoLoader = (function () {
  const cacheStorage = new CacheStorage(sessionStorage);

  const parseFromHtml5Watch = function (dom) {
    const watchDataContainer = dom.querySelector('#js-initial-watch-data');
    const {
      // baseURL,
      frontendId,
      frontendVersion,
      // i18n,
      // isMonitoringLogUser,
      // newPlaylistRate,
      // newRelatedVideos,
      playlistToken, //項目は残ってるけど値は出なくなってる
      // urls,
    } = JSON.parse(watchDataContainer.getAttribute('data-environment'));

    const _data = JSON.parse(watchDataContainer.getAttribute('data-api-data'));
    const {
      context = {}, // contextがない
      thread = {}, // threadがない
      // ads,
      // category,
      channel, // nullable
      client: {
        // nicosid,
        watchId,
        // watchTrackId,
      },
      comment: {
        // isAttentionRequired,
        keys: {
          userKey,
        },
        layers,
        ng: {
          channel: channelNg,
          // ngScore,
          owner: ownerNg,
          // viewer,
        },
        // nvComment,
        server: {
          url: commentServer,
        },
        threads,
      },
      community, // nullable
      // easyComment,
      external: {
        commons: {
          hasContentTree,
        },
        // ichiba,
      },
      // genre,
      // marquee,
      media: {
        delivery: dmcInfo, // nullable
        // deliveryLegacy,
      },
      // okReason,
      owner, // nullable
      payment: {
        // preview,
        video: {
          // commentableUserType,
          // isAdmission,
          // isPpv,
          isPremium: isPremiumOnly,
          // watchableUserType,
        },
      },
      // pcWatchPage,
      player: {
        // comment,
        initialPlayback, // nullable
        // layerMode,
      },
      // ppv,
      // ranking,
      series,
      // smartphone,
      // system,
      tag: {
        // edit,
        // hasR18Tag,
        // isPublishedNicoscript,
        items: tags,
        // viewer,
      },
      video: {
        dmcInfo: videoDmcInfo = {}, // dmcInfoがない
        smileInfo: flvInfo = {}, // smileInfoがない
        flvInfo: {
          url: videoUrl = '',
        } = flvInfo,
        // 9d091f87, // version hash?
        // commentableUserTypeForPayment,
        count: {
          comment: commentCount,
          like: likeCount,
          mylist: mylistCount,
          view: viewCount,
        },
        description,
        duration,
        id: videoId,
        // isAuthenticationRequired,
        // isDeleted,
        // isEmbedPlayerAllowed,
        // isGiftAllowed,
        // isNoBanner,
        // isPrivate,
        // rating,
        registeredAt,
        thumbnail: {
          largeUrl: thumbnailUrl, // null
          // middleUrl,
          // ogp,
          url: thumbnail,
          player: largeThumbnail,
        },
        title,
        viewer: videoStatusForViewer, // nullable
        // watchableUserTypeForPayment,
      },
      // videoAds,
      // videoLive,
      viewer, // nullable
      // waku,
    } = JSON.parse(watchDataContainer.getAttribute('data-api-data'));

    const hasLargeThumbnail = nicoUtil.hasLargeThumbnail(videoId);
    const csrfToken = null;
    const watchAuthKey = null;
    layers.forEach(layer => {
      layer.threadIds.forEach(({id, fork}) => {
        threads.forEach(thread => {
          if (thread.id === id && fork === 0) {
            thread.layer = layer;
          }
        });
      });
    });
    const resumeInfo = (() => {
      const {
        type = '',
        positionSec = null,
      } = { ...initialPlayback };
      return {
        initialPlaybackType: type,
        initialPlaybackPosition: positionSec ?? 0,
      };
    })();
    const isLiked = videoStatusForViewer?.like.isLiked ?? false;
    const viewerInfo = (() => {
      const {
        id = 0,
        isPremium = false,
      } = { ...viewer };
      return { id, isPremium };
    })();
    const linkedChannelVideo = false;
    const isNeedPayment = false;
    const defaultThread = threads.find(t => t.isDefaultPostTarget);
    const msgInfo = {
      server: commentServer,
      threadId: defaultThread ? defaultThread.id : (thread.ids && (thread.ids.community || thread.ids.default)),
      duration,
      userId: viewerInfo.id,
      isNeedKey: threads.findIndex(t => t.isThreadkeyRequired) >= 0, // (isChannel || isCommunity)
      optionalThreadId: '',
      defaultThread,
      optionalThreads: threads.filter(t => t.id !== defaultThread.id) || [],
      threads,
      userKey,
      hasOwnerThread: threads.find(t => t.isOwnerThread),
      when: null,
      frontendId,
      frontendVersion
    };

    const isPlayable = !!dmcInfo?.movie.session;

    cacheStorage.setItem('csrfToken', csrfToken, 30 * 60 * 1000);

    const playlist = {playlist: []};

    const tagList = tags.map(tag => {
      const {
        // isCategory, // カテゴリ廃止
        // isCategoryCandidate,
        isLocked,
        isNicodicArticleExists,
        name,
      } = tag;
      return {
        _data: tag,
        isLocked,
        isLockedBySystem: isLocked ? 1 : 0,
        isNicodicArticleExists,
        name,
      }
    });

    let channelInfo, channelId, uploaderInfo = null;
    if (channel) {
      const {
        id,
        // isDisplayAdBanner,
        // isOfficialAnime,
        name,
        thumbnail: {
          smallUrl,
          url,
        },
        // viewer: {
        //   follow: {
        //     isBookmarked,
        //     isFollowed,
        //     token,
        //     tokenTimestamp,
        //   },
        // },
      } = { ...channel };
      channelInfo = {
        icon_url: smallUrl ?? url ?? '',
        id,
        name,
      };
      channelId = id;
    }
    if (owner) {
      const {
        // channel,
        iconUrl,
        id,
        // isMylistsPublic,
        // isVideosPublic,
        // live,
        nickname,
        // videoLiveNotice,
        // viewer: {
        //   isFollowing,
        // },
      } = { ...owner };
      uploaderInfo = {
        icon_url: iconUrl,
        id,
        nickname,
      };
    }

    const watchApiData = {
      videoDetail: {
        v: watchId,
        id: videoId,
        title,
        // title_original: data.video.originalTitle,
        description,
        // description_original: data.video.originalDescription,
        postedAt: new Date(registeredAt).toLocaleString(),
        thumbnail,
        largeThumbnail,
        length: duration,

        commons_tree_exists: hasContentTree,

        // width: data.video.width,
        // height: data.video.height,

        isChannel: channel && channel.id,
        isMymemory: false,
        communityId: community?.id ?? null,
        isPremiumOnly,
        isLiked,
        channelId,

        commentCount,
        likeCount,
        mylistCount,
        viewCount,

        tagList,
      },
      viewerInfo,
      channelInfo,
      uploaderInfo
    };

    let ngFilters = [];
    if (videoDmcInfo && videoDmcInfo.thread) {
      if (videoDmcInfo.thread.channel_ng_words && videoDmcInfo.thread.channel_ng_words.length) {
        ngFilters = videoDmcInfo.thread.channel_ng_words;
      } else if (videoDmcInfo.thread.owner_ng_words && videoDmcInfo.thread.owner_ng_words.length) {
        ngFilters = videoDmcInfo.thread.owner_ng_words;
      }
    }
    if (data.context && data.context.ownerNGList && data.context.ownerNGList.length) {
      ngFilters = Array.prototype.concat(ngFilters, data.context.ownerNGList);
    }

    ngFilters = Array.prototype.concat(ngFilters, channelNg, ownerNg);

    if (ngFilters.length) {
      const ngtmp = [];
      ngFilters.forEach(ng => {
        if (!ng.source || !ng.destination) { return; }
        ngtmp.push(
          encodeURIComponent(ng.source) + '=' + encodeURIComponent(ng.destination));
      });
      flvInfo.ng_up = ngtmp.join('&');
    }

    const result = {
      _format: 'html5watchApi',
      _data,
      watchApiData,
      flvInfo,
      dmcInfo: dmcInfo ?? {},
      msgInfo,
      playlist,
      isDmcOnly: true,
      isPlayable,
      isMp4: false,
      isFlv: false,
      isSwf: false,
      isEco: false,
      isDmc: isPlayable,
      thumbnailUrl,
      csrfToken,
      watchAuthKey,
      playlistToken,
      series,

      isNeedPayment,
      linkedChannelVideo,
      resumeInfo,
    };

    emitter.emitAsync('csrfTokenUpdate', csrfToken);
    return result;
  };


  const parseWatchApiData = function (src) {
    const dom = new DOMParser().parseFromString(src, 'text/html');
    if (dom.querySelector('#js-initial-watch-data')) {
      return parseFromHtml5Watch(dom);
    } else if (dom.querySelector('#PAGEBODY .mb16p4 .font12')) {
      return {
        reject: true,
        reason: 'forbidden',
        message: dom.querySelector('#PAGEBODY .mb16p4 .font12').textContent,
      };
    } else {
      return null;
    }
  };


  const loadLinkedChannelVideoInfo = (originalData) => {
    const linkedChannelVideo = originalData.linkedChannelVideo;
    const originalVideoId = originalData.watchApiData.videoDetail.id;
    const videoId = linkedChannelVideo.linkedVideoId;

    originalData.linkedChannelData = null;
    if (originalVideoId === videoId) {
      return Promise.reject();
    }

    const url = `https://www.nicovideo.jp/watch/${videoId}`;
    window.console.info('%cloadLinkedChannelVideoInfo', 'background: cyan', linkedChannelVideo);
    return new Promise(r => {
      setTimeout(r, 1000);
    }).then(() => netUtil.fetch(url, {credentials: 'include'}))
      .then(res => res.text())
      .then(html => {
        const dom = new DOMParser().parseFromString(html, 'text/html');
        const data = parseFromHtml5Watch(dom);
        //window.console.info('linkedChannelData', data);
        originalData.dmcInfo = data.dmcInfo;
        originalData.isDmcOnly = data.isDmcOnly;
        originalData.isPlayable = data.isPlayable;
        originalData.isMp4 = data.isMp4;
        originalData.isFlv = data.isFlv;
        originalData.isSwf = data.isSwf;
        originalData.isEco = data.isEco;
        originalData.isDmc = data.isDmc;
        return originalData;
      })
      .catch(() => {
        return Promise.reject({reason: 'network', message: '通信エラー(loadLinkedChannelVideoInfo)'});
      });
  };

  const onLoadPromise = (watchId, options, isRetry, resp) => {
    const data = parseWatchApiData(resp);
    debug.watchApiData = data;
    if (!data) {
      return Promise.reject({
        reason: 'network',
        message: '通信エラー。動画情報の取得に失敗しました。(watch api)'
      });
    }

    if (data.reject) {
      return Promise.reject(data);
    }

    if (!data.isDmc && (data.isFlv && !data.isEco)) {
      return Promise.reject({
        reason: 'flv',
        info: data,
        message: 'この動画はZenzaWatchで再生できません(flv)'
      });
    }

    if (
      !data.isPlayable &&
      data.isNeedPayment &&
      data.linkedChannelVideo &&
      Config.getValue('loadLinkedChannelVideo')) {
      return loadLinkedChannelVideoInfo(data);
    }

    if (!data.isPlayable) {
      return Promise.reject({
        reason: 'not supported',
        info: data,
        message: 'この動画はZenzaWatchで再生できません'
      });
    }

    emitter.emitAsync('loadVideoInfo', data, 'WATCH_API', watchId);
    return Promise.resolve(data);
  };

  const createSleep = function (sleepTime) {
    return new Promise(resolve => setTimeout(resolve, sleepTime));
  };

  const loadPromise = function (watchId, options, isRetry = false) {
    let url = `https://www.nicovideo.jp/watch/${watchId}`;
    console.log('%cloadFromWatchApiData...', 'background: lightgreen;', watchId, url);
    const query = [];
    if (options.economy === true) {
      query.push('eco=1');
    }
    if (query.length > 0) {
      url += '?' + query.join('&');
    }

    return netUtil.fetch(url, {credentials: 'include'})
      .then(res => res.text())
      .catch(() => Promise.reject({reason: 'network', message: '通信エラー(network)'}))
      .then(onLoadPromise.bind(this, watchId, options, isRetry))
      .catch(err => {
        window.console.error('err', {err, isRetry, url, query});
        if (isRetry) {
          return Promise.reject({
            watchId,
            message: err.message || '動画情報の取得に失敗したか、未対応の形式です',
            type: 'watchapi'
          });
        }

        if (err.reason === 'forbidden') {
          return Promise.reject(err);
        } else if (err.reason === 'network') {
          return createSleep(5000).then(() => {
            window.console.warn('network error & retry');
            return loadPromise(watchId, options, true);
          });
        } else if (err.reason === 'flv' && !options.economy) {
          options.economy = true;
          window.console.log(
            '%cエコノミーにフォールバック(flv)',
            'background: cyan; color: red;');
          return createSleep(500).then(() => {
            return loadPromise(watchId, options, true);
          });
        } else {
          window.console.info('watch api fail', err);
          return Promise.reject({
            watchId,
            message: err.message || '動画情報の取得に失敗',
            info: err.info
          });
        }
      });
  };

  return {
    load: function (watchId, options) {
      const timeKey = `watchAPI:${watchId}`;
      window.console.time(timeKey);
      return loadPromise(watchId, options).then(
        (result) => {
          window.console.timeEnd(timeKey);
          return result;
        },
        (err) => {
          err.watchId = watchId;
          window.console.timeEnd(timeKey);
          return Promise.reject(err);
        }
      );
    }
  };
})();

//===END===

export {VideoInfoLoader};