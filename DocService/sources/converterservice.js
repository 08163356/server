/*
 * (c) Copyright Ascensio System SIA 2010-2016
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at Lubanas st. 125a-25, Riga, Latvia,
 * EU, LV-1021.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

var config = require('config');
var co = require('co');
const forwarded = require('forwarded');
var taskResult = require('./taskresult');
var logger = require('./../../Common/sources/logger');
var utils = require('./../../Common/sources/utils');
var constants = require('./../../Common/sources/constants');
var commonDefines = require('./../../Common/sources/commondefines');
var docsCoServer = require('./DocsCoServer');
var canvasService = require('./canvasservice');
var storage = require('./../../Common/sources/storage-base');
var formatChecker = require('./../../Common/sources/formatchecker');
var statsDClient = require('./../../Common/sources/statsdclient');

var cfgHealthCheckFilePath = config.get('services.CoAuthoring.server.healthcheckfilepath');
var cfgVisibilityTimeout = config.get('queue.visibilityTimeout');
var cfgQueueRetentionPeriod = config.get('queue.retentionPeriod');

var CONVERT_TIMEOUT = 1.5 * (cfgVisibilityTimeout + cfgQueueRetentionPeriod) * 1000;
var CONVERT_ASYNC_DELAY = 1000;

var clientStatsD = statsDClient.getClient();

function* getConvertStatus(cmd, selectRes, baseUrl) {
  var status = {url: undefined, err: constants.NO_ERROR};
  if (selectRes.length > 0) {
    var docId = cmd.getDocId();
    var row = selectRes[0];
    switch (row.status) {
      case taskResult.FileStatus.Ok:
        status.url = yield storage.getSignedUrl(baseUrl, docId + '/' + cmd.getTitle());
        break;
      case taskResult.FileStatus.Err:
      case taskResult.FileStatus.ErrToReload:
        status.err = row.status_info;
        if (taskResult.FileStatus.ErrToReload == row.status) {
          yield canvasService.cleanupCache(docId);
        }
        break;
      case taskResult.FileStatus.NeedParams:
      case taskResult.FileStatus.SaveVersion:
      case taskResult.FileStatus.UpdateVersion:
        status.err = constants.UNKNOWN;
        break;
      case taskResult.FileStatus.NeedPassword:
        status.err = row.status_info;
        break;
    }
    var lastOpenDate = row.last_open_date;
    if (new Date().getTime() - lastOpenDate.getTime() > CONVERT_TIMEOUT) {
      status.err = constants.CONVERT_TIMEOUT;
    }
  }
  return status;
}

function* convertByCmd(cmd, async, baseUrl, opt_healthcheck) {
  var docId = cmd.getDocId();
  var startDate = null;
  if (clientStatsD) {
    startDate = new Date();
  }
  logger.debug('Start convert request docId = %s', docId);

  var task = new taskResult.TaskResultData();
  task.key = docId;
  task.status = taskResult.FileStatus.WaitQueue;
  task.statusInfo = constants.NO_ERROR;
  task.title = cmd.getTitle();

  var upsertRes = yield taskResult.upsert(task);
  //if CLIENT_FOUND_ROWS don't specify 1 row is inserted , 2 row is updated, and 0 row is set to its current values
  //http://dev.mysql.com/doc/refman/5.7/en/insert-on-duplicate.html
  var bCreate = upsertRes.affectedRows == 1;
  var selectRes;
  var status;
  if (!bCreate && !opt_healthcheck) {
    selectRes = yield taskResult.select(docId);
    status = yield* getConvertStatus(cmd, selectRes, baseUrl);
  } else {
    var queueData = new commonDefines.TaskQueueData();
    queueData.setCmd(cmd);
    queueData.setToFile(cmd.getTitle());
    if (opt_healthcheck) {
      queueData.setFromOrigin(true);
    }
    yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);
    status = {url: undefined, err: constants.NO_ERROR};
  }
  //wait
  if (!async) {
    var waitTime = 0;
    while (true) {
      if (status.url || constants.NO_ERROR != status.err) {
        break;
      }
      yield utils.sleep(CONVERT_ASYNC_DELAY);
      selectRes = yield taskResult.select(docId);
      status = yield* getConvertStatus(cmd, selectRes, baseUrl);
      waitTime += CONVERT_ASYNC_DELAY;
      if (waitTime > CONVERT_TIMEOUT) {
        status.err = constants.CONVERT_TIMEOUT;
      }
    }
  }
  logger.debug('End convert request url %s status %s docId = %s', status.url, status.err, docId);
  if (clientStatsD) {
    clientStatsD.timing('coauth.convertservice', new Date() - startDate);
  }
  return status;
}

function convertHealthCheck(req, res) {
  return co(function* () {
    var output = false;
    try {
      logger.debug('Start convertHealthCheck');
      var task = yield* taskResult.addRandomKeyTask('healthcheck');
      var docId = task.key;
      //put test file to storage
      var data = yield utils.readFile(cfgHealthCheckFilePath);
      var format = 'docx';
      yield storage.putObject(docId + '/origin.' + format, data, data.length);
      //convert
      var cmd = new commonDefines.InputCommand();
      cmd.setCommand('conv');
      cmd.setSaveKey(docId);
      cmd.setFormat(format);
      cmd.setDocId(docId);
      cmd.setTitle('Editor.bin');
      cmd.setOutputFormat(constants.AVS_OFFICESTUDIO_FILE_CANVAS);

      var status = yield* convertByCmd(cmd, false, utils.getBaseUrlByRequest(req), true);
      if (status && constants.NO_ERROR == status.err) {
        output = true;
      }
      //clean up
      yield canvasService.cleanupCache(docId);
      logger.debug('End convertHealthCheck');
    } catch (e) {
      logger.error('Error convertHealthCheck\r\n%s', e.stack);
    } finally {
      res.send(output.toString());
    }
  });
}

function* convertFromChanges(docId, baseUrl, lastSave, userdata) {
  var cmd = new commonDefines.InputCommand();
  cmd.setCommand('sfcm');
  cmd.setDocId(docId);
  cmd.setOutputFormat(constants.AVS_OFFICESTUDIO_FILE_OTHER_TEAMLAB_INNER);
  cmd.setEmbeddedFonts(false);
  cmd.setCodepage(commonDefines.c_oAscCodePageUtf8);
  cmd.setDelimiter(commonDefines.c_oAscCsvDelimiter.Comma);
  cmd.setLastSave(lastSave);
  cmd.setUserData(userdata);

  yield* canvasService.commandSfctByCmd(cmd);
  return yield* convertByCmd(cmd, true, baseUrl);
}

function convertRequest(req, res) {
  return co(function* () {
    var docId = 'null';
    try {
      var cmd = new commonDefines.InputCommand();
      cmd.setCommand('conv');
      cmd.setVKey(req.query['vkey']);
      cmd.setUrl(req.query['url']);
      cmd.setEmbeddedFonts(false);//req.query['embeddedfonts'];
      cmd.setFormat(req.query['filetype']);
      var outputtype = req.query['outputtype'] || '';
      docId = 'conv_' + req.query['key'] + '_' + outputtype;
      cmd.setDocId(docId);
      cmd.setTitle(constants.OUTPUT_NAME + '.' + outputtype);
      cmd.setOutputFormat(formatChecker.getFormatFromString(outputtype));
      cmd.setCodepage(commonDefines.c_oAscEncodingsMap[req.query['codePage']] || commonDefines.c_oAscCodePageUtf8);
      cmd.setDelimiter(req.query['delimiter'] || commonDefines.c_oAscCsvDelimiter.Comma);
      cmd.setDoctParams(req.query['doctparams']);
      cmd.setPassword(req.query['password']);
      var thumbnail = req.query['thumbnail'];
      if (thumbnail) {
        var thumbnailData = new commonDefines.CThumbnailData(JSON.parse(req.query['thumbnail']));
        //constants from CXIMAGE_FORMAT_
        switch (cmd.getOutputFormat()) {
          case constants.AVS_OFFICESTUDIO_FILE_IMAGE_JPG:
            thumbnailData.setFormat(3);
            break;
          case constants.AVS_OFFICESTUDIO_FILE_IMAGE_PNG:
            thumbnailData.setFormat(4);
            break;
          case constants.AVS_OFFICESTUDIO_FILE_IMAGE_GIF:
            thumbnailData.setFormat(2);
            break;
          case constants.AVS_OFFICESTUDIO_FILE_IMAGE_BMP:
            thumbnailData.setFormat(1);
            break;
        }
        cmd.setThumbnail(thumbnailData);
        cmd.setOutputFormat(constants.AVS_OFFICESTUDIO_FILE_IMAGE);
      }
      var async = 'true' == req.query['async'];

      if (constants.AVS_OFFICESTUDIO_FILE_UNKNOWN !== cmd.getOutputFormat()) {
        var status = yield* convertByCmd(cmd, async, utils.getBaseUrlByRequest(req));
        utils.fillXmlResponse(res, status.url, status.err);
      } else {
        var addresses = forwarded(req);
        logger.error('Error convert unknown outputtype: query = %s from = %s docId = %s', JSON.stringify(req.query), addresses, docId);
        utils.fillXmlResponse(res, undefined, constants.UNKNOWN);
      }
    }
    catch (e) {
      logger.error('Error convert: docId = %s\r\n%s', docId, e.stack);
      utils.fillXmlResponse(res, undefined, constants.UNKNOWN);
    }
  });
}

exports.convertHealthCheck = convertHealthCheck;
exports.convertFromChanges = convertFromChanges;
exports.convert = convertRequest;
