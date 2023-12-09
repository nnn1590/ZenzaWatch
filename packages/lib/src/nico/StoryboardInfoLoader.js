import {util} from '../../../../src/util';
import {VideoSessionWorker} from './VideoSessionWorker';
//===BEGIN===

const StoryboardInfoLoader = {
  load: videoInfo => {
    if (videoInfo.hasDomandStoryboard) {
      return Promise.reject('currently, not supported domand storyboard');
    }
    if (videoInfo.hasDmcStoryboard) {
      const watchId = videoInfo.watchId;
      const info = videoInfo.dmcStoryboardInfo;
      const duration = videoInfo.duration;
      return VideoSessionWorker.storyboard(watchId, info, duration);
    }

    return Promise.reject('smile storyboard api not exist');
  }
};


//===END===
//
export {
  StoryboardInfoLoader,
};


