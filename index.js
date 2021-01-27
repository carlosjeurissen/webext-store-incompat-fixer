#!/usr/bin/env node
'use strict';

const fs = require('fs');
const JSZip = require('jszip');

const executionPath = process.argv[1].replace(/\\+/g, '/');
const usedAsCli = executionPath.endsWith('/webext-store-incompat-fixer') || executionPath.endsWith('/webext-store-incompat-fixer/index.js');

const storeTheming = {
  firefox: '\x1b[31m',
  whale: '\x1b[36m',
  edge: '\x1b[32m',
  safari: '\x1b[34m'
};

function stringifyInOriginalFormat (originalString, newJson) {
  if (originalString.indexOf('\t') !== -1) {
    return JSON.stringify(newJson, '\t', 1);
  }
  if (originalString.indexOf('  ') !== -1) {
    return JSON.stringify(newJson, ' ', 2);
  }
  return JSON.stringify(newJson);
}

function handleEdgeLocaleExclusions (zip, manifestString, manifestJson, params) {
  const defaultLocale = manifestJson.default_locale;
  const messagesMatch = manifestString.match(/__MSG_(.+?)__/g);

  let changed = false;

  if (!defaultLocale || !messagesMatch) {
    return Promise.resolve(changed);
  }

  const messagesToRemove = messagesMatch.map(function (item) {
    return item.match(/__MSG_(.+)__/)[1];
  });

  if (messagesToRemove.length === 0) {
    return Promise.resolve(changed);
  }

  const forcedInclusions = Array.isArray(params.edgeLocaleInclusions) ? params.edgeLocaleInclusions : [];
  forcedInclusions.push(defaultLocale);

  const updatePromises = [];
  const localeRegex = /^_locales\/(.+)\/messages\.json$/;

  zip.file(localeRegex).forEach(function (file) {
    const fileName = file.name;
    const localeId = fileName.match(localeRegex)[1];
    if (forcedInclusions.includes(localeId)) return;

    const readPromise = file.async('string').then(function (result) {
      const localeJson = JSON.parse(result);
      let messageFound = false;
      messagesToRemove.forEach(function (messageId) {
        if (localeJson[messageId]) {
          messageFound = true;
          delete localeJson[messageId];
        }
      });
      if (messageFound) {
        changed = true;
        const localeString = stringifyInOriginalFormat(result, localeJson);
        zip.file(fileName, localeString);
      }
    });

    updatePromises.push(readPromise);
  });

  return Promise.all(updatePromises).then(function () {
    return changed;
  });
}

function handleSinglePackage (data, store, params) {
  const packageChanges = [];

  const zip = new JSZip();

  return zip.loadAsync(data).then(function () {
    return zip.file('manifest.json').async('string');
  }).then(function (manifestString) {
    let manifestChanged = false;

    const manifestJson = JSON.parse(manifestString);

    if (store === 'whale') {
      // handle incompatible locale files
      const fallbacks = {
        zh_Hans: 'zh_CN',
        zh_Hant: 'zh_TW',
        sr_Latn: 'sr'
      };

      const incompatLocaleMatch = /^_locales\/(zh_Hans|zh_Hant|sr_Latn)\/messages\.json$/;
      zip.file(incompatLocaleMatch).forEach(function (file) {
        const localeId = file.name.match(incompatLocaleMatch)[1];
        const fallbackLocaleId = fallbacks[localeId];
        const fallbackName = '_locales/' + fallbackLocaleId + '/messages.json';
        const fallbackFile = zip.file(fallbackName);
        if (fallbackFile) {
          packageChanges.push('Removed ' + localeId + ' from package');
        } else {
          packageChanges.push('Renamed ' + localeId + ' translations to ' + fallbackLocaleId);
          zip.file(fallbackName, file.async('uint8array'));
        }
        zip.remove('_locales/' + localeId);
      });

      // remove tm symbol if found, as the store doesn't render it correctly
      const hasTmSymbol = manifestJson.name && manifestJson.name.includes('™');
      if (hasTmSymbol) {
        manifestJson.name = manifestJson.name.replace(/™/g, '');
        manifestChanged = true;
        packageChanges.push('Removed ™ symbol from name');
      }
    }

    if (store === 'safari' || store === 'firefox') {
      const originalCsp = manifestJson.content_security_policy || '';
      if (originalCsp) {
        const optionsUi = manifestJson.options_ui;
        const inlineOptionsUi = optionsUi && !optionsUi.external;
        let cspChanged = false;
        let newCsp = originalCsp.split(/,+ ?/).map((singleCsp) => {
          return singleCsp.split(/;+ ?/).filter((part) => {
            if (store !== 'safari' || !part.startsWith('sandbox')) return true;
            packageChanges.push('CSP: Sandbox removed, breaks styles');
            cspChanged = true;
            return false;
          }).map((part) => {
            if (store !== 'firefox') return part;
            if (!inlineOptionsUi) return part;
            if (!part.startsWith('frame-ancestors')) return part;
            if ((part + ' ').includes(' about: ')) return part;
            packageChanges.push('CSP: added about: to frame-ancestors to fix the inline options page in firefox ESR');
            cspChanged = true;
            return part + ' about:';
          }).join('; ');
        }).join(', ');

        if (store === 'firefox') {
          if (newCsp.includes(' \'report-sample\'')) {
            cspChanged = true;
            newCsp = newCsp.replace(/ 'report-sample'/g, '');
            packageChanges.push('CSP: removed \'report-sample\'. see: https://bugzilla.mozilla.org/show_bug.cgi?id=1618141');
          }

          if (newCsp.includes(' \'strict-dynamic\'')) {
            cspChanged = true;
            newCsp = newCsp.replace(/ 'strict-dynamic'/g, '');
            packageChanges.push('CSP: removed \'strict-dynamic\'. see: https://bugzilla.mozilla.org/show_bug.cgi?id=1618141');
          }
        }

        if (cspChanged) {
          manifestJson.content_security_policy = newCsp;
          manifestChanged = true;
        }
      }
    }

    if (manifestChanged) {
      const manifestFinal = stringifyInOriginalFormat(manifestString, manifestJson);
      zip.file('manifest.json', manifestFinal);
    }

    // removes translations from messages used in the manifest file
    // this allows the inclusion of translation without the need
    // to enter all store assets for each language

    if (store === 'edge') {
      return handleEdgeLocaleExclusions(zip, manifestString, manifestJson, params).then(function (changed) {
        if (changed) {
          packageChanges.push('Removed translations for messages in manifest.json');
        }
      });
    }
  }).then(function () {
    if (packageChanges.length > 0) {
      return { zip, packageChanges };
    }
  });
}

function cleanStoreInput (inputStores) {
  const supportedStores = ['firefox', 'edge', 'whale', 'safari'];
  if (!Array.isArray(inputStores) || inputStores.length === 0) return supportedStores;
  return supportedStores.filter(function (store) {
    return inputStores.includes(store);
  });
}

function readSingleFile (inputPath) {
  return new Promise(function (resolve, reject) {
    return fs.readFile(inputPath, function (err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

function writeZipToDisk (zip, outputPath) {
  const outputStream = fs.createWriteStream(outputPath);
  const inputStream = zip.generateNodeStream({
    streamFiles: true
  });

  return new Promise(function (resolve) {
    inputStream.pipe(outputStream).on('finish', function () {
      resolve();
    });
  });
}

function readJsonFile (filePath) {
  try {
    const fileText = fs.readFileSync(filePath);
    return JSON.parse(fileText);
  } catch (e) {
    console.log('Couldn\'t read json file: ' + e);
  }
}

function getVersion () {
  const version = process.env.npm_package_version;
  if (version) return version;
  const packageJson = readJsonFile('./package.json') || {};
  return packageJson.version || 'unknown';
}

function generate (params) {
  const stores = cleanStoreInput(params.stores);
  const version = getVersion();
  const inputPath = params.inputPath.replace('{version}', version);
  return readSingleFile(inputPath).then(function (data) {
    return Promise.all(stores.map(function (store) {
      return handleSinglePackage(data, store, params).then(function (result) {
        const fancyStoreName = store.toUpperCase();
        const colorReset = '\x1b[0m';
        console.log('\x1b[1m\n' + storeTheming[store] + fancyStoreName + colorReset);

        if (result) {
          const { zip, packageChanges } = result;
          const outputPath = inputPath.replace('.zip', '-' + store + '.zip');
          packageChanges.forEach(function (changeMessage) {
            console.log('- ' + changeMessage);
          });
          return writeZipToDisk(zip, outputPath);
        } else {
          console.log('\x1b[2m- No adaptions needed\x1b[0m');
        }
      });
    }));
  }).then(function () {
    console.log('\nHandled store incompatibilities');
  });
}

if (usedAsCli) {
  const argList = process.argv.join('=').split('=');
  let inputPath = null;
  let edgeLocaleInclusions = null;
  const stores = [];
  argList.forEach((item, index) => {
    if (item === '--input' || item === '-i') {
      inputPath = argList[index + 1];
    } else if (item === '--stores' || item === '--store' || item === '-s') {
      stores.push(...argList[index + 1].toLowerCase().split(/[^a-z]/));
    } else if (item === '--edge-locale-inclusions') {
      edgeLocaleInclusions = argList[index + 1].split(',');
    }
  });

  generate({
    inputPath: inputPath,
    stores: stores,
    edgeLocaleInclusions: edgeLocaleInclusions
  });
}

exports.generate = generate;
module.exports = exports.generate;
