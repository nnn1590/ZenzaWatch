import {util} from '../util';
import {PopupMessage} from '../util';
// import jsdom from 'jsdom';
import {sleep} from '../../packages/lib/src/infra/sleep';
import {netUtil} from '../../../lib/src/infra/netUtil';
import {textUtil} from '../../../lib/src/text/textUtil';
import {nicoUtil} from '../../../lib/src/nico/nicoUtil';

const JSDOM = {} ; //jsdom.JSDOM;
const debug = {};

//===BEGIN===

const {ThreadLoader} = (() => {
  const VERSION_OLD = '20061206';
  const VERSION     = '20090904';
  const FRONT_ID = '6';
  const FRONT_VER = '0';

  const LANG_CODE = {
    'en_us': 1,
    'zh_tw': 2
  };

  class ThreadLoader {

    constructor() {
      this._threadKeys = {};
    }

    /**
     * 動画の長さに応じて取得するコメント数を変える
     * 本家よりちょっと盛ってる
     */
    getRequestCountByDuration(duration) {
      if (duration < 60)  { return 100; }
      if (duration < 240) { return 200; }
      if (duration < 300) { return 400; }
      return 1000;
    }

    async getThreadKey(videoId, options = {}) {
      let url = `https://nvapi.nicovideo.jp/v1/comment/keys/thread?videoId=${videoId}`;

      console.log('getThreadKey url: ', url);
      const headers = Object.assign({
        'X-Frontend-Id': 6,
        'X-Frontend-Version': 0
      }, options.cookie ? {Cookie: options.cookie} : {});
      try {
        const { data } = await netUtil.fetch(url, {
          headers,
          credentials: 'include'
        }).then(res => res.json());
        this._threadKeys[videoId] = data.threadKey;
        return data
      } catch (result) {
        throw { result, message: `ThreadKeyの取得失敗 ${videoId}` }
      }
    }

    getLangCode(language = '') {
      language = language.replace('-', '_').toLowerCase();
      if (LANG_CODE[language]) {
        return LANG_CODE[language];
      }
      return 0;
    }

    async getPostKey(threadId, options = {}) {
      const url = `https://nvapi.nicovideo.jp/v1/comment/keys/post?threadId=${threadId}`;

      console.log('getPostKey url: ', url);
      const headers = Object.assign({
        'X-Frontend-Id': 6,
        'X-Frontend-Version': 0
      }, options.cookie ? {Cookie: options.cookie} : {});
      try {
        const { data } = await netUtil.fetch(url, {
          headers,
          credentials: 'include'
        }).then(res => res.json());
        return data
      } catch (result) {
        throw { result, message: `PostKeyの取得失敗 ${threadId}` }
      }
    }

    buildPacketData(msgInfo, options = {}) {
      const packets = [];
      const resCount = this.getRequestCountByDuration(msgInfo.duration);
      const leafContent = `0-${Math.floor(msgInfo.duration / 60) + 1}:100,${resCount},nicoru:100`;
      const language = this.getLangCode(msgInfo.language);

      msgInfo.threads.forEach(thread => {
        if (!thread.isActive) { return; }

        const t = {
          thread: thread.id.toString(),
          user_id: msgInfo.userId > 0 ? msgInfo.userId.toString() : '', // 0の時は空文字
          language,
          nicoru: 3,
          scores: 1
        };
        if (thread.isThreadkeyRequired) {
          t.threadkey = msgInfo.threadKey[thread.id].key;
          t.force_184 = msgInfo.threadKey[thread.id].force184 ? '1' : '0';
        }
        if (msgInfo.when > 0) {
          t.when = msgInfo.when;
        }
        if (thread.fork) {
          t.fork = thread.fork;
        }
        if (options.resFrom > 0) {
          t.res_from = options.resFrom;
        }
        // threadkeyかwaybackkeyがある場合にuserkeyをつけてしまうとエラー。いらないなら無視すりゃいいだろが
        if (!t.threadkey /*&& !t.waybackkey*/ && msgInfo.userKey) {
          t.userkey = msgInfo.userKey;
        }
        if (t.fork || thread.isLeafRequired === false) { // 投稿者コメントなど
          packets.push({thread: Object.assign({with_global: 1, version: VERSION_OLD, res_from: -1000}, t)});
        } else {
          packets.push({thread: Object.assign({with_global: 1, version: VERSION}, t)});
          packets.push({thread_leaves: Object.assign({content: leafContent}, t)});
        }
      });
      return packets;
    }

    buildPacket(msgInfo, options = {}) {
      const data = this.buildPacketData(msgInfo);
      if (options.format !== 'xml') {
        return JSON.stringify(data);
      }
      const packet = document.createElement('packet');
      data.forEach(d => {
        const t = document.createElement(d.thread ? 'thread' : 'thread_leaves');
        const thread = d.thread ? d.thread : d.thread_leaves;
        Object.keys(thread).forEach(attr => {
          if (attr === 'content') {
            t.textContent = thread[attr];
            return;
          }
          t.setAttribute(attr, thread[attr]);
        });
        packet.append(t);
      });
      return packet.outerHTML;
    }

    _post(server, body, options = {}) {
      const url = server;
      return netUtil.fetch(url, {
        method: 'POST',
        dataType: 'text',
        headers: {'Content-Type': 'text/plain; charset=UTF-8'},
        body
      }).then(res => {
        if (options.format !== 'xml') {
          return res.json();
        }
        return res.text().then(text => {
          if (DOMParser) {
            return new DOMParser().parseFromString(text, 'application/xml');
          }
          return (new JSDOM(text)).window.document;
        });
      }).catch(result => {
        return Promise.reject({
          result,
          message: `コメントの通信失敗 server: ${server}`
        });
      });
    }

    async _load(msgInfo, options = {}) {
      const {
        params,
        threadKey
      } = msgInfo.nvComment

      const packet = {
        additionals: {},
        params,
        threadKey
      }

      if (options.retrying) {
        const info = await this.getThreadKey(msgInfo.videoId, options);
        console.log('threadKey: ', msgInfo.videoId, info);
        packet.threadKey = info.threadKey;
      }

      if (msgInfo.when > 0) {
        packet.additionals.when = msgInfo.when;
      }

      const url = 'https://nvcomment.nicovideo.jp/v1/threads';
      console.log('load threads...', url, packet);
      const headers = {
        'X-Frontend-Id': 6,
        'X-Frontend-Version': 0,
        'Content-Type': 'text/plain; charset=UTF-8'
      };
      try {
        const result = await netUtil.fetch(url, {
          method: 'POST',
          dataType: 'text',
          headers,
          body: JSON.stringify(packet)
        }).then(res => res.json());
        return result.data;
      } catch (result) {
        throw {
          result,
          message: `コメントの通信失敗`
        }
      }
    }

    async load(msgInfo, options = {}) {
      const videoId = msgInfo.videoId;
      const userId   = msgInfo.userId;

      const timeKey = `loadComment videoId: ${videoId}`;
      console.time(timeKey);

      let result;
      try {
        result = await this._load(msgInfo, options);
      } catch (e) {
        console.timeEnd(timeKey);
        window.console.error('loadComment fail 1st: ', e);
        PopupMessage.alert('コメントの取得失敗: 3秒後にリトライ');

        await sleep(3000);
        try {
          console.time(timeKey);
          const result = await this._load(msgInfo, { retrying: true, ...options });
        } catch (e) {
          console.timeEnd(timeKey);
          window.console.error('loadComment fail finally: ', e);
          throw {
            message: 'コメントサーバーの通信失敗'
          }
        }
      }

      console.timeEnd(timeKey);
      debug.lastMessageServerResult = result;

      let totalResCount = result.globalComments[0].count;
      let threadId;
      for (const thread of result.threads) {
        threadId = parseInt(thread.id, 10);
        const forkLabel = thread.fork;
        // 投稿者コメントはGlobalにカウントされていない
        if (forkLabel === 'easy') {
          // かんたんコメントをカウントしていない挙動に合わせる。不要？
          const resCount = thread.commentCount;
          totalResCount -= resCount;
        }
      }

      const threadInfo = {
        userId,
        videoId,
        threadId,
        is184Forced:   msgInfo.defaultThread.is184Forced,
        totalResCount,
        language:   msgInfo.language,
        when:       msgInfo.when,
        isWaybackMode: !!msgInfo.when
      };

      msgInfo.threadInfo = threadInfo;

      console.log('threadInfo: ', threadInfo);
      return {threadInfo, body: result, format: 'threads'};
    }

    async _postChat(threadInfo, postkey, text, cmd, vpos) {
      const packet = JSON.stringify([{chat: {
        content: text,
        mail: cmd || '',
        vpos: vpos || 0,
        premium: util.isPremium() ? 1 : 0,
        postkey,
        user_id: threadInfo.userId.toString(),
        ticket: threadInfo.ticket,
        thread: threadInfo.threadId.toString()
      }}]);
      console.log('post packet: ', packet);
      const server = threadInfo.server.replace('/api/', '/api.json/');
      const result = await this._post(server, packet, 'json');

      let status = null, chat_result, no = 0, blockNo = 0;
      try {
        chat_result = result.find(t => t.chat_result).chat_result;
        status = chat_result.status * 1;
        no = parseInt(chat_result.no, 10);
        blockNo = Math.floor((no + 1) / 100);
      } catch (e) {
        console.error(e);
      }
      if (status === 0) {
        return {
          status: 'ok',
          no,
          blockNo,
          code: status,
          message: 'コメント投稿成功'
        };
      }
      return Promise.reject({
        status: 'fail',
        no,
        blockNo,
        code: status,
        message: `コメント投稿失敗 status: ${status} server: ${threadInfo.server}`
      });
    }

    async postChat(msgInfo, text, cmd, vpos, lang) {
      const threadInfo = msgInfo.threadInfo;
      const tk = await this.getPostKey(threadInfo.threadId, { language: lang });
      const postkey = tk.postkey;
      let result = await this._postChat(threadInfo, postkey, text, cmd, vpos, lang).catch(r => r);
      if (result.status === 'ok') {
        return result;
      }
      const errorCode = parseInt(result.code, 10);
      if (errorCode === 3) { // ticket fail
        await this.load(msgInfo);
      } else if (![2, 4, 5].includes(errorCode)) { // リカバー不能系
        return Promise.reject(result);
      }
      await sleep(3000);
      result = await this._postChat(threadInfo, postkey, text, cmd, vpos, lang).catch(r => r);
      return result.status === 'ok' ? result : Promise.reject(result);
    }


    getNicoruKey(threadId, langCode = 0, options = {}) {
      const url =
        `https://nvapi.nicovideo.jp/v1/nicorukey?language=${langCode}&threadId=${threadId}`;

      console.log('getNicorukey url: ', url);
      const headers = options.cookie ? {Cookie: options.cookie} : {};
      Object.assign(headers, {
        'X-Frontend-Id': FRONT_ID,
          // 'X-Frontend-Version': FRONT_VER
        });
      return netUtil.fetch(url, {
        headers,
        credentials: 'include'
      }).then(res => res.json())
        .then(js => {
          if (js.meta.status === 200) {
            return js.data;
          }
          return Promise.reject({status: js.meta.status});
        }).catch(result => {
        return Promise.reject({
          result,
          message: `NicoruKeyの取得失敗 ${threadId}`
        });
      });
    }

    async nicoru(msgInfo, chat) {
      const threadInfo = msgInfo.threadInfo;
      const language = this.getLangCode(msgInfo.language);
      const {nicorukey} = await this.getNicoruKey(chat.threadId, language);
      const server = threadInfo.server.replace('/api/', '/api.json/');
      const body = JSON.stringify({nicoru:{
        content: chat.text,
        fork: chat.fork || 0,
        id: chat.no.toString(),
        language,
        nicorukey,
        postdate: `${chat.date}.${chat.dateUsec}`,
        premium: nicoUtil.isPremium() ? 1 : 0,
        thread: chat.threadId.toString(),
        user_id: msgInfo.userId.toString()
      }});
      const result = await this._post(server, body);
      const [{nicoru_result: {status}}] = result;
      if (status === 4) {
        return Promise.reject({status, message: 'ニコり済みだった'});
      } else if (status !== 0) {
        return Promise.reject({status, message: `ニコれなかった＞＜ (status:${status})`});
      }
      return result;
    }
  }

  return {ThreadLoader: new ThreadLoader};
})();




//===END===

export {ThreadLoader};
