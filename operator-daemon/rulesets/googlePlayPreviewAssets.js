const RULESET_ID = 'googlePlayPreviewAssets.v2026';

const png = {
  extensions: ['.png'],
  mimeTypes: ['image/png']
};

const jpegOrPng = {
  extensions: ['.jpg', '.jpeg', '.png'],
  mimeTypes: ['image/jpeg', 'image/png']
};

const ruleset = {
  id: RULESET_ID,
  roles: {
    playStoreAppIcon: {
      ...png,
      pngColorTypes: [6],
      width: 512,
      height: 512,
      alpha: 'required',
      maxBytes: 1024 * 1024
    },
    playStoreFeatureGraphic: {
      ...jpegOrPng,
      pngColorTypes: [2, 6],
      width: 1024,
      height: 500,
      alpha: 'blocked'
    },
    playStorePhoneScreenshot: {
      ...jpegOrPng,
      pngColorTypes: [2, 6],
      minDimension: 320,
      maxDimension: 3840,
      maxAspectRatio: 2,
      alpha: 'blocked'
    },
    playStoreTabletScreenshot: {
      ...jpegOrPng,
      pngColorTypes: [2, 6],
      minDimension: 320,
      maxDimension: 3840,
      maxAspectRatio: 2,
      alpha: 'blocked'
    }
  }
};

module.exports = {
  RULESET_ID,
  ruleset
};
