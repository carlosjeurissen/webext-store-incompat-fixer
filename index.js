#!/usr/bin/env node
'use strict';

const fs = require('fs');
const JSZip = require('jszip');

const executionPath = process.argv[1].replace(/\\+/g, '/');
const usedAsCli = executionPath.endsWith('/webext-store-incompat-fixer') || executionPath.endsWith('/webext-store-incompat-fixer/index.js');

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

  let packageChanged = false;

  if (!defaultLocale || !messagesMatch) {
    return Promise.resolve(packageChanged);
  }

  const messagesToRemove = messagesMatch.map(function (item) {
    return item.match(/__MSG_(.+)__/)[1];
  });

  if (messagesToRemove.length === 0) {
    return Promise.resolve(packageChanged);
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
        packageChanged = true;
        const localeString = stringifyInOriginalFormat(result, localeJson);
        zip.file(fileName, localeString);
      }
    });

    updatePromises.push(readPromise);
  });

  return Promise.all(updatePromises).then(function () {
    return packageChanged;
  });
}

function handleSinglePackage (data, store, params) {
  let packageChanged = false;
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
        zh_Hant: 'zh_TW'
      };

      const incompatLocaleMatch = /^_locales\/(zh_Hans|zh_Hant)\/messages\.json$/;
      zip.file(incompatLocaleMatch).forEach(function (file) {
        const localeId = file.name.match(incompatLocaleMatch)[1];
        const fallbackLocaleId = fallbacks[localeId];
        const fallbackName = '_locales/' + fallbackLocaleId + '/messages.json';
        const fallbackFile = zip.file(fallbackName);
        if (!fallbackFile) {
          zip.file(fallbackName, file.async('uint8array'));
        }
        zip.remove('_locales/' + localeId);
        packageChanged = true;
      });

      // remove tm symbol if found, as the store doesn't render it correctly
      const hasTmSymbol = manifestJson.name && manifestJson.name.includes('™');
      if (hasTmSymbol) {
        manifestJson.name = manifestJson.name.replace(/™/g, '');
        manifestChanged = true;
      }
    }

    if (store === 'firefox') {
      let csp = manifestJson.content_security_policy;

      if (typeof csp === 'string') {
        const optionsUi = manifestJson.options_ui;

        // makes sure the options page can be embedded in the firefox UI
        if (
          optionsUi &&
          !optionsUi.external &&
          csp.indexOf('frame-ancestors ') !== -1 &&
          !csp.split('frame-ancestors ')[1].split(';')[0].split(',')[0].includes('about:')
        ) {
          manifestChanged = true;
          csp = csp.replace('frame-ancestors ', 'frame-ancestors about: ');
          manifestJson.content_security_policy = csp;
        }

        if (csp.includes(' \'report-sample\'')) {
          manifestChanged = true;
          csp = csp.replace(/ 'report-sample'/g, '');
          manifestJson.content_security_policy = csp;
        }

        if (csp.includes(' \'strict-dynamic\'')) {
          manifestChanged = true;
          csp = csp.replace(/ 'strict-dynamic'/g, '');
          manifestJson.content_security_policy = csp;
        }
      }

      // remove management from optional permissions
      const optionalPermissions = manifestJson.optional_permissions;
      if (Array.isArray(optionalPermissions) && optionalPermissions.includes('management')) {
        manifestChanged = true;
        optionalPermissions.splice(optionalPermissions.indexOf('management'), 1);
      }
    }

    if (manifestChanged) {
      packageChanged = true;
      const manifestFinal = stringifyInOriginalFormat(manifestString, manifestJson);
      zip.file('manifest.json', manifestFinal);
    }

    // removes translations from messages used in the manifest file
    // this allows the inclusion of translation without the need
    // to enter all store assets for each language

    if (store === 'edge') {
      return handleEdgeLocaleExclusions(zip, manifestString, manifestJson, params).then(function (changed) {
        if (changed) {
          packageChanged = true;
        }
      });
    }
  }).then(function () {
    if (packageChanged) {
      return zip;
    }
  });
}

function cleanStoreInput (inputStores) {
  const supportedStores = ['firefox', 'edge', 'whale'];
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

function generate (params) {
  const stores = cleanStoreInput(params.stores);
  const version = process.env.npm_package_version;
  const inputPath = params.inputPath.replace('{version}', version);
  return readSingleFile(inputPath).then(function (data) {
    return Promise.all(stores.map(function (store) {
      return handleSinglePackage(data, store, params).then(function (zip) {
        if (zip) {
          const outputPath = inputPath.replace('.zip', '-' + store + '.zip');
          console.log(store + ' - writing adapted package');
          return writeZipToDisk(zip, outputPath);
        }
        console.log(store + ' - no adaptions needed');
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
