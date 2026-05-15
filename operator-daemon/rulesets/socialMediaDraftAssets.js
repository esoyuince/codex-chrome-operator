const RULESET_ID = 'socialMediaDraftAssets.v2026';

const jpegOrPng = {
  extensions: ['.jpg', '.jpeg', '.png'],
  mimeTypes: ['image/jpeg', 'image/png']
};

const socialDraftImage = {
  ...jpegOrPng,
  pngColorTypes: [2, 6],
  minDimension: 1,
  maxDimension: 8192,
  maxBytes: 8 * 1024 * 1024
};

const ruleset = {
  id: RULESET_ID,
  roles: {
    socialImage: socialDraftImage,
    screenshot: socialDraftImage,
    screenshotImage: socialDraftImage
  }
};

module.exports = {
  RULESET_ID,
  ruleset
};
