# webext-store-incompat-fixer
Package which clones a packed webextension and fixes incompatibilities with certain extension stores.


## usage
webext-store-incompat-fixer --input somepackage.zip --stores edge,whale,firefox

or
const webextStoreIncompatFixer = require('webext-store-incompat-fixer');
webextStoreIncompatFixer({
  'inputPath': 'some-package.zip',
  'stores': ['edge', 'whale', 'firefox']
}).then(function () {
  console.log('finished');
})

Keep in mind it will only create separate packages if and only if adaptions are needed.


## background
The idea behind this package is to allow one to keep one code base for all stores. This package doesn't cover all incompatibilities. If one is missing, feel free to open an issue.

The adaptions are mostly needed because of issues in the store. This means once those are fixed, adaptions in this package will be removed as well.


## firefox adaptions
In addition, the content security policy is modified in two ways.
1) we remove report-sample and strict-dynamic from script-src as it breaks the csp
https://bugzilla.mozilla.org/show_bug.cgi?id=1618141

2) if an inline options page is used, we add the about: protocol to frame-ancestors. This makes sure the options page can be rendered in firefox android, and in older firefox versions.


## edge adaptions (Chromium-based)
The microsoft edge store currently requires store assets for each language included in the extension. Say you support 50 languages and have 5 screenshots. You will have to upload 250 files manually. And that is only the screenshots.

To overcome this, we make use of the language detection system of the edge store. It will only ask for additional assets if there is a translation for items found in the manifest file. Thus we simply remove those translations and keep others.

To force include a certain language, use the --edge-locale-inclusions option with a comma separated list of locales.

Microsoft confirmed this issue will be fixed at some point. Once they have, this adaption will be removed.


## whale adaptions
The whale store currently doesn't handle some characters. For now we remove the ™ symbol. Open an issue if there are more characters we should handle.

In addition, the whale store doesn't accept all language codes. Specifically, it requires language suffix to be a country code, which doesn't work for zh_Hans and zh_Hant. Those language files are moved to zh_CN and zh_TW if not found. Else it will simply remove the directories.

The Whale team mentioned they won't fix the language issue however they are currently looking into the character issue.

A forum post about the issues can be found here:
https://forum.whale.naver.com/topic/27841/


## safari adaptions
The sandbox directive is removed from the content_security_policy field.
