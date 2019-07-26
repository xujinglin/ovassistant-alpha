const express        = require('express');  
const app            = express();   
const Sentry         = require('@sentry/node');
const zmq            = require('zeromq');
const sock           = zmq.socket('sub');
const sock1          = zmq.socket('sub');
const zlib           = require('zlib')
const _              = require('lodash');
const cors           = require('cors');             
const bodyParser     = require('body-parser');
const utils          = require('./utils');
const moment         = require('moment-timezone');
const redisImportController = require('./controllers/import-redis');
const { promisify } = require('util');
const redisClient = require('./redis-client.js');
const redisClientPersist = require('./redis-client-persist');
const util = require('util')
const fs = require('fs')
const { ingestLatestGTFS, testCron } = require('./cron/index')
const cron = require('node-cron')

const redis = require('redis');
const redisClient2 = redis.createClient({
  url: process.env.REDIS_URL || 'redis://redis/0'
});

Sentry.init({ dsn: 'https://39c9c5b61e1d41eb93ba664950bd3416@sentry.io/1339156' });
const parseString = require('xml2js').parseString;
const stripPrefix = require('xml2js').processors.stripPrefix;

app.use(Sentry.Handlers.requestHandler());
app.use(cors())
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json()); 

var port = process.env.PORT || 8000;

var router = express.Router();

cron.schedule('0 0 3 * * *', () => {
  ingestLatestGTFS({ force: true })
  console.log('GTFS Ingestion Scheduled!')
}, {
  scheduled: true, 
  timezone: "Europe/Amsterdam"
})

router.use((req, res, next) => {
  // do logging
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  console.log('Something is happening.');
  next(); // make sure we go to the next routes and don't stop here
});

router.get('/*', (req, res) => {
  res.json({ message: '200' });   
});

app.use(Sentry.Handlers.errorHandler());
// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(res.sentry + '\n');
});

// REGISTER OUR ROUTES -------------------------------
// all of our routes will be prefixed with /api
app.use('/api', router);
app.set('view engine', 'jade'); 

app.listen(port, '127.0.0.1', () => {
  console.log('servert listening on: ', port)
  ingestLatestGTFS({ force: false })
});

const zlibWrapper = {
  unzip: promisify(zlib.unzip).bind(zlib) 
}

redisClient.send_command('CONFIG', ['SET', 'notify-keyspace-events', 'Ex'], (err, callback) => {
  console.log('send command', err, callback)
});

redisClient2.send_command('CONFIG', ['SET', 'notify-keyspace-events', 'Ex'], (err, callback) => {
  console.log('send command', err, callback)
});

redisClient2.on("pmessage", function (pattern, channel, message) {
  redisClient.zrem('items', message)
});

redisClient2.psubscribe('__keyevent*__:expired');


const redisFlush = function() { 
  console.log('start flushing')
  const flushStatus = redisClientPersist.flushall() 

  console.log('flush all: ', flushStatus)  
}

redisFlush()


sock.connect('tcp://pubsub.besteffort.ndovloket.nl:7664');
sock.subscribe('/');

sock.on('message', async (topic, message) => {
  try {
    const buffer = await zlibWrapper.unzip(message)
    const data = buffer.toString('utf8')
    
    let result = await new Promise((resolve, reject) => parseString(data, { tagNameProcessors: [ stripPrefix ]}, (err, result) => {
      if(err) reject(err) 
      else resolve(result)
    }))

    if(_.has(result, 'ArrayOfTreinLocation')) {
      result = _.get(result, 'ArrayOfTreinLocation.TreinLocation')
      result.forEach((train) => {
        const speed = _.get(train, 'TreinMaterieelDelen.0.Snelheid.0')
        const id = 'train:' + _.get(train, 'TreinNummer.0')
        const latitude = Number(_.get(train, 'TreinMaterieelDelen.0.Latitude.0'))
        const longitude = Number(_.get(train, 'TreinMaterieelDelen.0.Longitude.0'))
        const orientation = Number(_.get(train, 'TreinMaterieelDelen.0.Richting.0'))
        const datetimeRaw = moment(train['TreinMaterieelDelen'][0]['GpsDatumTijd'][0])
        const datetime = moment(datetimeRaw, 'YYYY-MM-DDTHH:mm:ss')
        const datetimeUnix = moment(datetime).unix()
        const type = 'train'
        if (latitude && longitude) { 
          redisImportController.importData({
            id: id, 
            latitude: latitude, 
            longitude: longitude, 
            orientation: orientation, 
            datetimeUnix: datetimeUnix, 
            type: type
          })
        }
      })
    } else if(_.has(result, 'PutReisInformatieBoodschapIn.ReisInformatieProductDVS.0.DynamischeVertrekStaat.0')) {
      result = _.get(result, 'PutReisInformatieBoodschapIn.ReisInformatieProductDVS.0.DynamischeVertrekStaat.0')
      let id = _.get(result, 'RitId.0')
      
      result.delay_seconds = 0 
      if (_.has(result, 'Trein.0.ExacteVertrekVertraging.0') && _.get(result, 'Trein.0.ExacteVertrekVertraging') !== 'PT0S') {
        result.has_delay = true;
        result.delay_seconds = moment.duration(_.get(data, 'Trein.0.ExacteVertrekVertraging.0')).asSeconds()
      }

      if (result.delay_seconds < 60) {
        result.has_delay = false
        // delete result.delay_seconds;
      } 

      if(id) {
        id = 'train:' + id; 
        // redisImportController.locationSanitaryCheck(id, redisWrapper)
        result.type = 'train'
        result.updated = Math.round((new Date()).getTime() / 1000)
        result.destination = _.get(result, 'Trein.0.PresentatieTreinEindBestemming.0.Uitingen.0.Uiting.0')
        result.subType = result.Trein[0].TreinSoort[0]._
        result.measurementTimestamp = moment()
        redisImportController.updateData(id, result)
      }
    }

  } catch(err) {
    Sentry.captureException(err)
  }
}); 

sock1.connect('tcp://pubsub.besteffort.ndovloket.nl:7658');
sock1.subscribe('/');

sock1.on('message', async (topic, message) => {
  try {
    const buffer = await zlibWrapper.unzip(message)
    const data = buffer.toString('utf8')

    let result = await new Promise((resolve, reject) => parseString(data, { tagNameProcessors: [ stripPrefix ]}, (err, result) => {
      if(err) reject(err) 
      else resolve(result)
    }))

    if (_.get(result, 'VV_TM_PUSH.DossierName.0') === 'KV6posinfo') {
      const positions = _.get(result, 'VV_TM_PUSH.KV6posinfo');

      _.forEach(positions, (messages) => {
        
        _.forEach(_.keys(messages), (positionType) => {
          
          const positionMessages = messages[positionType]
          _.forEach(positionMessages, (positionMessage, i) => {
            const id = `vehicle:${positionMessage.dataownercode[0]}:${positionMessage.lineplanningnumber[0]}:${positionMessage.journeynumber[0]}`
            // console.log('vehicle: ', positionMessage)
            if (positionType === 'END') {
              redisClient.del(id)
              redisImportController.locationSanitaryCheck(id)
              // redisClient.zrem('items', id)
            } else {
              // console.log('positionMessage: ', positionMessage)
              const nowUnix = Math.round((new Date()).getTime() / 1000)

              const data = {
                id: id, 
                type: 'vehicle', 
                agencyCode: positionMessage.dataownercode[0], 
                datetimeUnix: nowUnix, 
                measurementTimestamp: positionMessage.timestamp[0]
              }

              if (positionMessage['rd-x'] && positionMessage['rd-x'][0] != -1 && positionMessage['rd-y'][0] != -1) {
                data.latitude = utils.RD2lat(positionMessage['rd-x'][0], positionMessage['rd-y'][0]);
                data.longitude = utils.RD2lng(positionMessage['rd-x'][0], positionMessage['rd-y'][0]);

                if (data.longitude < -180 || data.longitude > 180) {
                  delete data.longitude
                }

                if (data.latitude < -85 || data.latitude > 85) {
                  delete data.latitude
                }
              }

              if (positionMessage.punctuality) {
                data.delay_seconds = positionMessage.punctuality[0]
        
                if (positionMessage.punctuality[0] > 60) {
                  data.has_delay = true
                } else {
                  data.has_delay = false
                }                  
              }

              if(data.latitude && data.longitude) {
                redisImportController.importData(data)
              }

              redisImportController.updateData(id, data);
            }
          })

        })

      })
    } else {
      // console.log('maybe interesting: ', result)
      if(_.has(result, 'PutReisInformatieBoodschapIn.ServiceInformatieProductVrijeTekstBerichtStation.0')) {
        // console.log('in other stuff: ', _.get(result, 'PutReisInformatieBoodschapIn.ServiceInformatieProductVrijeTekstBerichtStation.0'))
      } else if(_.has(result, 'PutReisInformatieBoodschapIn.ServiceInformatieProductVrijeTekstBerichtTrein.0')) {
        // console.log('in other stuff trein: ', _.get(result, 'PutReisInformatieBoodschapIn.ServiceInformatieProductVrijeTekstBerichtTrein.0'))
      } else if(_.has(result, 'PutReisInformatieBoodschapIn.ServiceInformatieProductVrijeTekstBerichtLandelijk.0')) {
        // console.log('in other stuff landelijk: ', _.get(result, 'PutReisInformatieBoodschapIn.ServiceInformatieProductVrijeTekstBerichtLandelijk.0'))
      }
    }
  } catch(err) {
    Sentry.captureException(err)
  }
})