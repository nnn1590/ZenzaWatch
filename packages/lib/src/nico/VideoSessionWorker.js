import {workerUtil} from '../infra/workerUtil';
import {StoryboardCacheDb} from './StoryboardCacheDb';
//===BEGIN===

const VideoSessionWorker = (() => {
  const func = function(self) {
    const SMILE_HEART_BEAT_INTERVAL_MS = 10 * 60 * 1000; // 10min
    const DMC_HEART_BEAT_INTERVAL_MS = 30 * 1000;      // 30sec

    const SESSION_CLOSE_FAIL_COUNT = 3;

    const VIDEO_QUALITY = {
      auto: /.*/,
      veryhigh: /_(1080p)$/,
      high: /_(720p)$/,
      mid: /_(540p|480p)$/,
      low: /_(360p)$/
    };

    const util = {
      fetch(url, params = {}) { // ブラウザによっては location.origin は 'blob:' しか入らない
        if (!location.origin.endsWith('.nicovideo.jp') && !/^blob:https?:\/\/[a-z0-9]+\.nicovideo\.jp\//.test(location.href)) {
          return self.xFetch(url, params);
        }
        const racers = [];
        let timer;

        const timeout = (typeof params.timeout === 'number' && !isNaN(params.timeout)) ? params.timeout : 30 * 1000;
        if (timeout > 0) {
          racers.push(new Promise((resolve, reject) =>
            timer = setTimeout(() => timer ? reject({name: 'timeout', message: 'timeout'}) : resolve(), timeout))
          );
        }

        const controller = AbortController ? (new AbortController()) : null;
        if (controller) {
          params.signal = controller.signal;
        }
        racers.push(fetch(url, params));
        return Promise.race(racers).catch(err => {
          if (err.name === 'timeout') {
            console.warn('request timeout', url, params);
            if (controller) {
              controller.abort();
            }
          }
          return Promise.reject(err.message || err);
        }).finally(() => timer = null);
      }
    };

    class DmcPostData {
      constructor(dmcInfo, videoQuality, {useHLS = true, useSSL = false}) {
        this._dmcInfo = dmcInfo;
        this._videoQuality = videoQuality || 'auto';
        this._useHLS = useHLS;
        this._useSSL = useSSL;
        this._useWellKnownPort = true;
      }

      toString() {
        let dmcInfo = this._dmcInfo;

        const availableVideos = dmcInfo.availableVideoIds;
        const reg = VIDEO_QUALITY[this._videoQuality] || VIDEO_QUALITY.auto;
        let videos;
        if (reg === VIDEO_QUALITY.auto) {
          videos = availableVideos;
        } else {
          videos = [availableVideos.find(v => reg.test(v)) ?? availableVideos[0]];
        }

        const audios = [dmcInfo.availableAudioIds[0]];

        let contentSrcIdSets =
          (this._useHLS && reg === VIDEO_QUALITY.auto) ?
            this._buildAbrContentSrcIdSets(videos, audios) :
            this._buildContentSrcIdSets(videos, audios);

        let http_parameters = {};
        let parameters = {
          use_ssl: this._useSSL ? 'yes' : 'no',
          use_well_known_port: this._useWellKnownPort ? 'yes' : 'no',
          transfer_preset: dmcInfo.transferPreset
        };
        if (this._useHLS) {
          parameters.segment_duration = 6000;//Config.getValue('video.hls.segmentDuration');
          if (dmcInfo.encryption){
            parameters.encryption = {
              hls_encryption_v1 : {
                encrypted_key : dmcInfo.encryption.encryptedKey,
                key_uri : dmcInfo.encryption.keyUri
              }
            };
          }
        } else if (!dmcInfo.protocols.includes('http')) {
          throw new Error('HLSに未対応');
        }
        http_parameters.parameters = this._useHLS ?
          {hls_parameters: parameters} :
          {http_output_download_parameters: parameters};

        const request = {
          session: {
            client_info: {
              player_id: dmcInfo.playerId
            },
            content_auth: {
              auth_type: dmcInfo.authTypes[this._useHLS ? 'hls' : 'http'] || 'ht2',
              content_key_timeout: dmcInfo.contentKeyTimeout,
              service_id: 'nicovideo',
              service_user_id: dmcInfo.serviceUserId,
              //max_content_count: 10,
            },
            content_id: dmcInfo.contentId,
            content_src_id_sets: contentSrcIdSets,
            content_type: 'movie',
            content_uri: '',
            keep_method: {
              heartbeat: {lifetime: dmcInfo.heartbeatLifetime}
            },
            priority: dmcInfo.priority,
            protocol: {
              name: 'http',
              parameters: {http_parameters}
            },
            recipe_id: dmcInfo.recipeId,

            session_operation_auth: {
              session_operation_auth_by_signature: {
                signature: dmcInfo.signature,
                token: dmcInfo.token
              }
            },

            timing_constraint: 'unlimited'
          }
        };

        return JSON.stringify(request, null, 2);
      }

      _buildContentSrcIdSets(videos, audios) {
        return [
          {
            content_src_ids: [
              {
                src_id_to_mux: {
                  audio_src_ids: audios,
                  video_src_ids: videos
                }
              }
            ]
          }
        ];
      }

      _buildAbrContentSrcIdSets(videos, audios) {
        const v = videos.concat();
        const contentSrcIds = [];
        while (v.length > 0) {
          contentSrcIds.push({
            src_id_to_mux: {
              audio_src_ids: [audios[0]],
              video_src_ids: v.concat()
            }
          });
          v.shift();
        }
        return [{content_src_ids: contentSrcIds}];
      }
    }


    class VideoSession {

      static create({serverType, ...params}) {
        if (serverType === 'domand') {
          return new DomandSession(params);
        } else if (serverType === 'dmc') {
          return new DmcSession(params);
        } else {
          throw new Error('Unknown server type');
        }
      }

      constructor({videoInfo, videoQuality, useHLS}) {
        this._videoInfo = videoInfo;

        this._isPlaying = () => true;
        this._pauseCount = 0;
        this._failCount = 0;
        this._lastResponse = '';
        this._videoQuality = videoQuality || 'auto';
        this._videoSessionInfo = {};
        this._isDeleted = false;
        this._isAbnormallyClosed = false;

        this._heartBeatTimer = null;

        this._useSSL = true;
        this._useHLS = !!useHLS;
        this._useWellKnownPort = true;

        this._onHeartBeatSuccess = this._onHeartBeatSuccess.bind(this);
        this._onHeartBeatFail = this._onHeartBeatFail.bind(this);
      }

      async connect() {
        this._createdAt = Date.now();
        return await this._createSession();
      }

      enableHeartBeat() {
        this.disableHeartBeat();
        this._heartBeatTimer =
          setInterval(this._onHeartBeatInterval.bind(this), this._heartBeatInterval);
      }

      changeHeartBeatInterval(interval) {
        if (this._heartBeatTimer) {
          clearInterval(this._heartBeatTimer);
        }
        this._heartBeatInterval = interval;
        this._heartBeatTimer =
          setInterval(this._onHeartBeatInterval.bind(this), this._heartBeatInterval);
      }

      disableHeartBeat() {
        if (this._heartBeatTimer) {
          clearInterval(this._heartBeatTimer);
        }
        this._heartBeatTimer = null;
      }

      _onHeartBeatInterval() {
        if (this._isClosed) {
          return;
        }
        this._heartBeat();
      }

      _onHeartBeatSuccess() {}

      _onHeartBeatFail() {
        this._failCount++;
        if (this._failCount >= SESSION_CLOSE_FAIL_COUNT) {
          this._isAbnormallyClosed = true;
          this.close();
        }
      }

      async close() {
        this._isClosed = true;
        this.disableHeartBeat();
        return await this._deleteSession();
      }

      get isDeleted() {
        return !!this._isDeleted;
      }

      get isDomand() {
        return false;
      }

      get isDmc() {
        return false;
      }

      get isAbnormallyClosed() {
        return this._isAbnormallyClosed;
      }
    }

    class DomandSession extends VideoSession {
      constructor(params) {
        super(params);
        this._serverType = 'domand';
        this._expireTime = new Date();
        this._domandInfo = this._videoInfo.domandInfo;
      }

      async _createSession() {
        console.time('create Domand session');
        if (!this._useHLS) {
          throw new Error('HLSに未対応');
        }
        const audio = this._domandInfo.availableAudioIds[0];
        const availableVideos = this._domandInfo.availableVideoIds;
        let video;
        if (this._videoQuality === 'auto') {
          video = availableVideos[0];
        } else {
          let reg = new RegExp(`-${this._videoQuality}$`);
          video = availableVideos.find(v => reg.test(v)) ?? availableVideos[0];
        }

        const query = new URLSearchParams({ actionTrackId: this._videoInfo.actionTrackId });
        const url = `https://nvapi.nicovideo.jp/v1/watch/${this._videoInfo.videoId}/access-rights/hls?${query.toString()}`;
        const result = await util.fetch(url, {
          method: 'post',
          headers: {
            'Content-Type': 'application/json',
            'X-Frontend-Id': 6,
            'X-Frontend-Version': '0',
            'X-Request-With': 'https://www.nicovideo.jp',
            'X-Access-Right-Key': this._domandInfo.accessRightKey,
          },
          credentials: 'include',
          body: JSON.stringify({outputs: [[video, audio]]})
        }).then(res => res.json());
        if (result.meta.status == null || result.meta.status >= 300) {
          throw new Error('cannot create domand session', result)
        }
        this._lastResponse = result.data || {};
        const {
          contentUrl,
          createTime,
          expireTime
        } = this._lastResponse;
        this._lastUpdate = Date.now();
        this._expireTime = new Date(expireTime);
        this._videoSessionInfo = {
          type: 'domand',
          url: contentUrl,
          videoFormat: video,
          audioFormat: audio,
          lastResponse: result
        };
        console.timeEnd('create Domand session');
        return this._videoSessionInfo;
      }

      async _deleteSession() {
        if (this._isDeleted) {
          return;
        }
        this._isDeleted = true;
      }

      get isDeleted() {
        if (this._isDeleted) {
          return true;
        }
        if (Date.now() > this._expireTime) {
          this._isDeleted = true;
        }
        return this._isDeleted;
      }

      get isDomand() {
        return true;
      }
    }

    class DmcSession extends VideoSession {
      constructor(params) {
        super(params);

        this._serverType = 'dmc';
        this._heartBeatInterval = DMC_HEART_BEAT_INTERVAL_MS;
        this._onHeartBeatSuccess = this._onHeartBeatSuccess.bind(this);
        this._onHeartBeatFail = this._onHeartBeatFail.bind(this);
        this._lastUpdate = Date.now();
        this._heartbeatLifetime = this._heartBeatInterval;
        this._dmcInfo = this._videoInfo.dmcInfo;
      }

      _createSession() {
        const dmcInfo = this._dmcInfo;
        console.time('create DMC session');
        const baseUrl = (dmcInfo.urls.find(url => url.is_well_known_port === this._useWellKnownPort) || dmcInfo.urls[0]).url;
        return new Promise((resolve, reject) => {
          const url = `${baseUrl}?_format=json`;

          this._heartbeatLifetime = dmcInfo.heartbeatLifetime;
          const postData = new DmcPostData(dmcInfo, this._videoQuality, {
            useHLS: this.useHLS,
            useSSL: url.startsWith('https://'),
            useWellKnownPort: true
          });

          util.fetch(url, {
            method: 'post',
            timeout: 10000,
            dataType: 'text',
            body: postData.toString()
          }).then(res => res.json())
            .then(json => {
              const data = json.data || {}, session = data.session || {};
              let sessionId = session.id;
              let content_src_id_sets = session.content_src_id_sets;
              let videoFormat =
                content_src_id_sets[0].content_src_ids[0].src_id_to_mux.video_src_ids[0];
              let audioFormat =
                content_src_id_sets[0].content_src_ids[0].src_id_to_mux.audio_src_ids[0];

              this._heartBeatUrl =
                `${baseUrl}/${sessionId}?_format=json&_method=PUT`;
              this._deleteSessionUrl =
                `${baseUrl}/${sessionId}?_format=json&_method=DELETE`;

              this._lastResponse = data;

              this._lastUpdate = Date.now();
              this._videoSessionInfo = {
                type: 'dmc',
                url: session.content_uri,
                sessionId,
                videoFormat,
                audioFormat,
                heartBeatUrl: this._heartBeatUrl,
                deleteSessionUrl: this._deleteSessionUrl,
                lastResponse: json
              };
              this.enableHeartBeat();
              console.timeEnd('create DMC session');
              resolve(this._videoSessionInfo);
            }).catch(err => {
            console.error('create api fail', err);
            reject(err.message || err);
          });
        });
      }

      get useHLS() {
        return this._useHLS &&
          this._dmcInfo.protocols.includes('hls');
      }

      _heartBeat() {
        let url = this._videoSessionInfo.heartBeatUrl;
        util.fetch(url, {
          method: 'post',
          dataType: 'text',
          timeout: 10000,
          body: JSON.stringify(this._lastResponse)
        }).then(res => res.json())
          .then(this._onHeartBeatSuccess)
          .catch(this._onHeartBeatFail);
      }

      _deleteSession() {
        if (this._isDeleted) {
          return Promise.resolve();
        }
        this._isDeleted = true;
        let url = this._videoSessionInfo.deleteSessionUrl;
        return new Promise(res => setTimeout(res, 3000)).then(() => {
          return util.fetch(url, {
            method: 'post',
            dataType: 'text',
            timeout: 10000,
            body: JSON.stringify(this._lastResponse)
          });
        }).catch(err => console.error('delete fail', err));
      }

      _onHeartBeatSuccess(result) {
        let json = result;
        this._lastResponse = json.data;
        this._lastUpdate = Date.now();
      }

      get isDeleted() {
        return !!this._isDeleted || (Date.now() - this._lastUpdate) > this._heartbeatLifetime * 1.2;
      }

      get isDmc() {
        return true;
      }
    }


    const DmcStoryboardInfoLoader = (() => {
      const parseStoryboard = sb => {
        const result = {
          id: 0,
          urls: [],
          quality: sb.quality,
          thumbnail: {
            width: sb.thumbnail_width,
            height: sb.thumbnail_height,
            number: null,
            interval: sb.interval
          },
          board: {
            rows: sb.rows,
            cols: sb.columns,
            number: sb.images.length
          }
        };
        sb.images.forEach(image => result.urls.push(image.uri));

        return result;
      };


      const parseMeta = meta => {
        const result = {
          format: 'dmc',
          status: meta.meta.message,
          url: null,
          movieId: null,
          storyboard: []
        };

        meta.data.storyboards.forEach(sb => {
          result.storyboard.unshift(parseStoryboard(sb));
        });

        // 画質の良い順にソート
        result.storyboard.sort((a, b) => {
          if (a.quality < b.quality) {
            return 1;
          }
          if (a.quality > b.quality) {
            return -1;
          }
          return 0;
        });

        return result;
      };


      const load = url => {
        return util.fetch(url, {credentials: 'include'}).then(res => res.json())
          .then(info => {
            if (!info.meta || !info.meta.message || info.meta.message !== 'ok') {
              return Promise.reject('storyboard request fail');
            }
            return parseMeta(info);
          });
      };

      return {
        load,
        _parseMeta: parseMeta,
        _parseStoryboard: parseStoryboard
      };
    })();

    class StoryboardSession {
      static create({serverType, ...params}) {
        if (serverType === 'domand') {
          throw new Error('currently, not supported domand storyboard');
          // return new DomandStoryboardSession(params);
        } else if (serverType === 'dmc') {
          return new DmcStoryboardSession(params);
        } else {
          throw new Error('Unknown server type');
        }
      }

      constructor({videoInfo}) {
        this._videoInfo = videoInfo;
      }

      async create() {
        return await this._createSession();
      }
    }

    class DmcStoryboardSession extends StoryboardSession {
      constructor(params) {
        super(params);
        this._info = this._videoInfo.dmcStoryboardInfo;
        this._url = this._info.urls[0].url;
      }

      async _createSession() {
        const url = `${this._url}?_format=json`;
        const body = this._createRequestString();
        try {
          const result = await util.fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json'
            },
            body
          }).then(res => res.json());
          if (!result || !result.data || !result.data.session || !result.data.session.content_uri) {
            throw 'api_not_exist';
          }
          return result;
        } catch (err) {
          if (err === 'api_not_exist') {
            throw 'DMC storyboard api not exist';
          }
          console.error('create dmc session fail', err);
          throw 'create dmc session fail';
        }
      }

      _createRequestString() {
        const info = this._info;

        // 階層が深くて目が疲れた
        const request = {
          session: {
            client_info: {
              player_id: info.playerId
            },
            content_auth: {
              auth_type: info.authTypes.storyboard,
              content_key_timeout: info.contentKeyTimeout,
              service_id: 'nicovideo',
              service_user_id: info.serviceUserId,
            },
            content_id: info.contentId,
            content_src_id_sets: [{
              content_src_ids: info.videos
            }],
            content_type: 'video',
            content_uri: '',
            keep_method: {
              heartbeat: {
                lifetime: info.heartbeatLifetime
              }
            },
            priority: info.priority,
            protocol: {
              name: 'http',
              parameters: {
                http_parameters: {
                  parameters: {
                    storyboard_download_parameters: {
                      use_well_known_port: 'yes',
                      use_ssl: 'yes'
                    }
                  }
                }
              }
            },
            recipe_id: info.recipeId,
            session_operation_auth: {
              session_operation_auth_by_signature: {
                signature: info.signature,
                token: info.token
              }
            },
            timing_constraint: 'unlimited'
          }
        };

        //console.log('storyboard session request', JSON.stringify(request, null, ' '));
        return JSON.stringify(request);
      }
    }




    const SESSION_ID = Symbol('SESSION_ID');
    const getSessionId = function() { return `session_${this.id++}`; }.bind({id: 0});

    let current = null;
    const create = async (params) => {
      if (current) {
        current.close();
        current = null;
      }
      current = await VideoSession.create(params);
      const sessionId = getSessionId();
      current[SESSION_ID] = sessionId;

      // console.log('create', sessionId, current[SESSION_ID]);
      return {
        isDomand: current.isDomand,
        isDmc: current.isDmc,
        sessionId
      };
    };

    const connect = async () => {
      // console.log('connect', sessionId, current[SESSION_ID]);
      return current.connect();
    };

    const getState = () => {
      if (!current) {
        return {};
      }
      // console.log('getState', sessionId, current[SESSION_ID]);
      return {
        isDomand: current.isDomand,
        isDmc: current.isDmc,
        isDeleted: current.isDeleted,
        isAbnormallyClosed: current.isAbnormallyClosed,
        sessionId: current[SESSION_ID]
      };
    };

    const close = () => {
      // current && console.log('close', sessionId, current[SESSION_ID]);
      current && current.close();
      current = null;
    };

    const storyboard = async ({videoInfo, serverType}) => {
      const result = await StoryboardSession.create({videoInfo, serverType}).create();
      const duration = videoInfo.duration;
      const uri = result.data.session.content_uri;
      const sbInfo = await DmcStoryboardInfoLoader.load(uri);
      for (let board of sbInfo.storyboard) {
        board.thumbnail.number = Math.floor(duration * 1000 / board.thumbnail.interval);
        board.urls = await Promise.all(
          board.urls.map(url => fetch(url).then(r => r.arrayBuffer()).catch(() => url)
        ));
        break; // 二番目以降は低画質
      }
      return {
        ...sbInfo,
        watchId: videoInfo.watchId,
        duration,
      };
    };

    self.onmessage = async ({command, params}) => {
      switch (command) {
        case 'create':
          return create(params);
        case 'connect':
          return await connect();
        case 'getState':
          return getState();
        case 'close':
          return close();
        case 'storyboard':
          return await storyboard(params);
      }
    };
  };

  let worker;
  const initWorker = () => {
    if (worker) { return worker; }
    worker = worker || workerUtil.createCrossMessageWorker(func, {name: 'VideoSessionWorker'});
  };
  const create = async ({videoInfo, videoQuality, serverType, useHLS}) => {
    await initWorker();
    const params = {
      videoInfo: videoInfo.toJSON(),
      videoQuality,
      serverType,
      useHLS
    };
    const result = await worker.post({command: 'create', params});
    const sessionId = result.sessionId;
    return Object.assign(result, {
      connect: () => worker.post({command: 'connect', params: {sessionId}}),
      getState: () => worker.post({command: 'getState', params: {sessionId}}),
      close: () => worker.post({command: 'close', params: {sessionId}})
    });
  };

  const storyboard = async ({type, info}) => {
    const videoInfo = info.toJSON();
    const cacheId = `${videoInfo.watchId}_${type}`;
    const cache = await StoryboardCacheDb.get(cacheId);
    if (cache) {
      return cache;
    }
    await initWorker();
    const params = {videoInfo, serverType: type};
    const result = await worker.post({command: 'storyboard', params});
    StoryboardCacheDb.put(cacheId, result);
    return result;
  };

  return {initWorker, create, storyboard};
})();

//===END===

export {VideoSessionWorker};