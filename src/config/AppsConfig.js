/**
 * Two-app configuration for the referral landing page + attribution logic.
 * Edit the placeholder values below once you have them.
 */

const APPS = {
  buyer: {
    packageName: 'com.headrick.swahili',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.headrick.swahili',
    sha256Fingerprint: 'D7:6D:63:1D:69:C9:7D:86:2C:17:3A:3A:43:8B:CE:E3:A1:36:F0:2F:99:42:60:F6:FB:20:4C:DA:CA:B3:A2:B3',
    // Custom URL scheme for in-app linking (warm start, QR codes you generate yourself)
    customScheme: 'swahilibuyer',
    displayName: 'Swahili Family',
  },
  seller: {
    packageName: 'com.swahilifamily.seller',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.swahilifamily.seller',
    sha256Fingerprint: '9D:77:10:12:5A:C8:F8:55:4B:FD:0C:07:97:A8:B2:45:16:A7:1E:BF:8F:9F:8A:04:44:A1:1F:61:50:B3:99:62',
    customScheme: 'swahiliseller',
    displayName: 'Swahili Family for Sellers',
  },
};

module.exports = { APPS };