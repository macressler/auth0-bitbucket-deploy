import _ from 'lodash';
import path from 'path';
import Promise from 'bluebird';
import { constants, unifyDatabases, unifyScripts } from 'auth0-source-control-extension-tools';
import { ArgumentError } from 'auth0-extension-tools';

import BitbucketApi from './bitbucketApi';
import config from './config';
import logger from '../lib/logger';


const bitbucket = () =>
  new BitbucketApi({
    user_name: config('BITBUCKET_USER'),
    password: config('BITBUCKET_PASSWORD'),
    rest_base: 'https://api.bitbucket.org/',
    rest_version: '1.0'
  });
/*
 * Check if a file is part of the rules folder.
 */
const isRule = (fileName) =>
fileName.indexOf(`${constants.RULES_DIRECTORY}/`) === 0;

/*
 * Check if a file is part of the database folder.
 */
const isDatabaseConnection = (fileName) =>
fileName.indexOf(`${constants.DATABASE_CONNECTIONS_DIRECTORY}/`) === 0;

/*
 * Check if a file is part of the pages folder.
 */
const isPage = (file) =>
file.indexOf(`${constants.PAGES_DIRECTORY}/`) === 0 && constants.PAGE_NAMES.indexOf(file.split('/').pop()) >= 0;

/*
 * Get the details of a database file script.
 */
const getDatabaseScriptDetails = (filename) => {
  const parts = filename.split('/');
  if (parts.length === 3 && /\.js$/i.test(parts[2])) {
    const scriptName = path.parse(parts[2]).name;
    if (constants.DATABASE_SCRIPTS.indexOf(scriptName) > -1) {
      return {
        database: parts[1],
        name: path.parse(scriptName).name
      };
    }
  }
  return null;
};

/*
 * Only Javascript and JSON files.
 */
const validFilesOnly = (fileName) => {
  if (isRule(fileName)) {
    return /\.(js|json)$/i.test(fileName);
  } else if (isDatabaseConnection(fileName)) {
    const script = getDatabaseScriptDetails(fileName);
    return !!script;
  }
  return false;
};

/**
 * only current pages could be uploaded
 * @param fileName
 * @returns {boolean}
 */
const validPageFilesOnly = (fileName) => isPage(fileName);

/*
 * Parse the repository.
 */
const parseRepo = (repository = '') => {
  const parts = repository.split('/');
  if (parts.length === 2) {
    const [ user, repo ] = parts;
    return { user, repo };
  } else if (parts.length === 5) {
    const [ , , , user, repo ] = parts;
    return { user, repo };
  }

  throw new ArgumentError(`Invalid repository: ${repository}`);
};

const checkRepo = (repository) =>
  new Promise((resolve, reject) => {
    try {
      const { user, repo } = parseRepo(repository);

      bitbucket().get('repositories/{username}/{repo_slug}', { username: user, repo_slug: repo }, (err) => {
        if (err) {
          return reject(err);
        }

        return resolve({ user, repo });
      });
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get pages tree.
 */
const getPagesTree = (params) =>
  new Promise((resolve, reject) => {
    try {
      bitbucket().get(`repositories/{username}/{repo_slug}/src/{revision}/${constants.PAGES_DIRECTORY}`, params, (err, res) => {
        if (err && err.statusCode === 404) {
          return resolve([]);
        } else if (err) {
          return reject(err);
        } else if (!res) {
          return resolve([]);
        }

        const files = res.files
          .filter(f => validPageFilesOnly(f.path));

        files.forEach((elem, idx) => {
          files[idx].path = elem.path;
        });

        return resolve(files);
      });
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get rules tree.
 */
const getRulesTree = (params) =>
  new Promise((resolve, reject) => {
    try {
      bitbucket().get(`repositories/{username}/{repo_slug}/src/{revision}/${constants.RULES_DIRECTORY}`, params, (err, res) => {
        if (err && err.statusCode === 404) {
          return resolve([]);
        } else if (err) {
          return reject(err);
        } else if (!res) {
          return resolve([]);
        }

        const files = res.files
          .filter(f => validFilesOnly(f.path));

        files.forEach((elem, idx) => {
          files[idx].path = elem.path;
        });

        return resolve(files);
      });
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get connection files for one db connection
 */
const getConnectionTreeByPath = (params, filePath) =>
  new Promise((resolve, reject) => {
    try {
      bitbucket().get(`repositories/{username}/{repo_slug}/src/{revision}/${filePath}`, params, (err, res) => {
        if (err) {
          return reject(err);
        } else if (!res) {
          return resolve([]);
        }
        const files = res.files
          .filter(f => validFilesOnly(f.path));

        files.forEach((elem, idx) => {
          files[idx].path = elem.path;
        });

        return resolve(files);
      });
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get all files for all database-connections.
 */
const getConnectionsTree = (params) =>
  new Promise((resolve, reject) => {
    try {
      bitbucket().get(`repositories/{username}/{repo_slug}/src/{revision}/${constants.DATABASE_CONNECTIONS_DIRECTORY}`, params, (err, res) => {
        if (err && err.statusCode === 404) {
          return resolve([]);
        } else if (err) {
          return reject(err);
        } else if (!res) {
          return resolve([]);
        }

        const subdirs = res.directories;
        const promisses = [];
        let files = [];

        _.forEach(subdirs, (dir) => {
          promisses.push(getConnectionTreeByPath(params, `${constants.DATABASE_CONNECTIONS_DIRECTORY}/${dir}`).then(data => {
            files = files.concat(data);
          }));
        });

        return Promise.all(promisses)
          .then(() => resolve(files));
      });
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get tree.
 */
const getTree = (parsedRepo, branch, sha, progress) => {
  const { user, repo } = parsedRepo;

  const params = {
    username: user,
    repo_slug: repo,
    revision: sha
  };
  const promises = {
    connections: getConnectionsTree(params),
    rules: getRulesTree(params),
    pages: getPagesTree(params)
  };
  return Promise.props(promises)
    .then((result) => (_.union(result.rules, result.connections, result.pages)))
    .catch(err => {
      if (progress && progress.log && err && err.report) {
        progress.log(err.report);
      }

      return Promise.reject(err);
    });
};

/*
 * Download a single file.
 */
const downloadFile = (parsedRepo, branch, file, shaToken) =>
  new Promise((resolve, reject) => {
    const { user, repo } = parsedRepo;
    const params = {
      username: user,
      repo_slug: repo,
      filename: file.path,
      revision: shaToken
    };
    const url = 'repositories/{username}/{repo_slug}/raw/{revision}/{filename}';
    bitbucket().get(url, params, (err, data) => {
      if (err !== null) {
        logger.error(`Error downloading '${file.path}'`);
        logger.error(err);
        reject(err);
      } else {
        resolve({
          fileName: file.path,
          contents: data
        });
      }
    });
  });


/*
 * Download a single rule with its metadata.
 */
const downloadRule = (parsedRepo, branch, ruleName, rule, shaToken) => {
  const currentRule = {
    script: false,
    metadata: false,
    name: ruleName
  };

  const downloads = [];

  if (rule.script) {
    downloads.push(downloadFile(parsedRepo, branch, rule.scriptFile, shaToken)
      .then(file => {
        currentRule.script = true;
        currentRule.scriptFile = file.contents;
      }));
  }

  if (rule.metadata) {
    downloads.push(downloadFile(parsedRepo, branch, rule.metadataFile, shaToken)
      .then(file => {
        currentRule.metadata = true;
        currentRule.metadataFile = file.contents;
      }));
  }

  return Promise.all(downloads)
    .then(() => currentRule);
};

/*
 * Determine if we have the script, the metadata or both.
 */
const getRules = (parsedRepo, branch, files, shaToken) => {
  // Rules object.
  const rules = {};

  // Determine if we have the script, the metadata or both.
  _.filter(files, f => isRule(f.path)).forEach(file => {
    const ruleName = path.parse(file.path).name;
    rules[ruleName] = rules[ruleName] || {};

    if (/\.js$/i.test(file.path)) {
      rules[ruleName].script = true;
      rules[ruleName].scriptFile = file;
    } else if (/\.json$/i.test(file.path)) {
      rules[ruleName].metadata = true;
      rules[ruleName].metadataFile = file;
    }
  });

  // Download all rules.
  return Promise.map(Object.keys(rules), (ruleName) =>
    downloadRule(parsedRepo, branch, ruleName, rules[ruleName], shaToken), { concurrency: 2 });
};

/*
 * Download a single database script.
 */
const downloadDatabaseScript = (parsedRepo, branch, databaseName, scripts, shaToken) => {
  const database = {
    name: databaseName,
    scripts: []
  };

  const downloads = [];
  scripts.forEach(script => {
    downloads.push(downloadFile(parsedRepo, branch, script, shaToken)
      .then(file => {
        database.scripts.push({
          name: script.name,
          scriptFile: file.contents
        });
      })
    );
  });

  return Promise.all(downloads)
    .then(() => database);
};

/*
 * Get all database scripts.
 */
const getDatabaseScripts = (parsedRepo, branch, files, shaToken) => {
  const databases = {};

  // Determine if we have the script, the metadata or both.
  _.filter(files, f => isDatabaseConnection(f.path)).forEach(file => {
    const script = getDatabaseScriptDetails(file.path);
    if (script) {
      databases[script.database] = databases[script.database] || [];
      databases[script.database].push({
        ...script,
        sha: file.sha,
        path: file.path
      });
    }
  });

  return Promise.map(Object.keys(databases), (databaseName) =>
    downloadDatabaseScript(parsedRepo, branch, databaseName, databases[databaseName], shaToken), { concurrency: 2 });
};

/*
 * Download a single page script.
 */
const downloadPage = (parsedRepo, branch, pageName, page, shaToken) => {
  const downloads = [];
  const currentPage = {
    metadata: false,
    name: pageName
  };

  if (page.file) {
    downloads.push(downloadFile(parsedRepo, branch, page.file, shaToken)
      .then(file => {
        currentPage.htmlFile = file.contents;
      }));
  }

  if (page.meta_file) {
    downloads.push(downloadFile(parsedRepo, branch, page.meta_file, shaToken)
      .then(file => {
        currentPage.metadata = true;
        currentPage.metadataFile = file.contents;
      }));
  }

  return Promise.all(downloads)
    .then(() => currentPage);
};

/*
 * Get all pages.
 */
const getPages = (parsedRepo, branch, files, shaToken) => {
  const pages = {};
  // Determine if we have the script, the metadata or both.
  _.filter(files, f => isPage(f.path)).forEach(file => {
    const pageName = path.parse(file.path).name;
    const ext = path.parse(file.path).ext;
    pages[pageName] = pages[pageName] || {};

    if (ext !== '.json') {
      pages[pageName].file = file;
      pages[pageName].sha = file.sha;
      pages[pageName].path = file.path;
    } else {
      pages[pageName].meta_file = file;
      pages[pageName].meta_sha = file.sha;
      pages[pageName].meta_path = file.path;
    }
  });

  return Promise.map(Object.keys(pages), (pageName) =>
    downloadPage(parsedRepo, branch, pageName, pages[pageName], shaToken), { concurrency: 2 });
};

/*
 * Get a list of all changes that need to be applied to rules and database scripts.
 */
export default (repository, branch, sha, progress) =>
  checkRepo(repository)
    .then((parsedRepo) => getTree(parsedRepo, branch, sha, progress)
      .then(files => {
        logger.debug(`Files in tree: ${JSON.stringify(files.map(file => ({
          path: file.path,
          sha: file.path
        })), null, 2)}`);

        const promises = {
          rules: getRules(parsedRepo, branch, files, sha),
          pages: getPages(parsedRepo, branch, files, sha),
          databases: getDatabaseScripts(parsedRepo, branch, files, sha)
        };

        return Promise.props(promises)
          .then((result) => Promise.resolve({
            rules: unifyScripts(result.rules),
            databases: unifyDatabases(result.databases),
            pages: unifyScripts(result.pages)
          }));
      }));
