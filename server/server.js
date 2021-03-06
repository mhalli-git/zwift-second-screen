﻿const express = require('express');
const expressWs = require('express-ws');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const compression = require('compression');
const stravaConnect = require('strava-live-segments/connect');

const Map = require('./map');
const PointsOfInterest = require('./pointsOfInterest');
const insertSiteSettings = require('./siteSettings');
const StravaSegments = require('./strava-segments');
const pollInterval = require('./pollInterval');

const EVENT_PREFIX = "event:";

const useForceSSL = (process.env.ForceSSL && process.env.ForceSSL.toLowerCase() == 'true');
const doForceSSL = useForceSSL
    ? (req, res, next) => {
      if (req.secure || (req.get('X-Forwarded-Proto') !== 'http')) {
        next();
      } else {
        res.redirect(301, 'https://' + req.hostname + req.originalUrl);
      }
    } : (req, res, next) => next();

class Server {
  constructor(riderProvider, settings) {
    this.riderProvider = riderProvider;
    this.settings = settings;
    this.hostData = settings ? settings.hostData : null;
    this.map = new Map(settings ? settings.worlds : null);
    this.siteSettings = settings ? settings.site : null;
    this.stravaSettings = settings ? settings.strava : null;

    if (this.stravaSettings) {
      this.stravaSegments = new StravaSegments(this.stravaSettings);
    }

    if (this.siteSettings && this.siteSettings.maintenanceMode) {
      this.maintenanceMode();
    } else {
      this.initialise();
    }
  }

  initialise() {
    this.app = express();
    if (this.riderProvider.login) {
      expressWs(this.app);
    }

    this.app.use(bodyParser.json())
    this.app.use(cookieParser())
    this.app.use(compression());

    if (this.stravaSettings) {
      const { clientId, clientSecret } = this.stravaSettings
      this.app.use('/strava', stravaConnect({ clientId, clientSecret, afterUrl: '/' }))
    }

    this.app.get('/logintype', (req, res) => {
      const type = this.riderProvider.login ? 'user' : 'id'
      const canLogout = this.riderProvider.canLogout;
      const canStrava = !!this.stravaSettings;
      const canSetWorld = this.riderProvider.canSetWorld;
      const canFilterRiders = this.riderProvider.canFilterRiders;
      sendJson(res, { type, canLogout, canStrava, canSetWorld, canFilterRiders });
    })

		// Enable CORS for post login
    this.app.options('/login', respondCORS)
    if (this.riderProvider.login) {
      this.app.post('/login', (req, res) => {
        const { username, password } = req.body
        console.log(`login: ${username}`)
        this.processLogin(res, this.riderProvider.login(username, password))
      })
    } else {
      this.app.post('/login', (req, res) => {
        const { id } = req.body
        console.log(`login: ${id}`)
        this.processLogin(res, this.riderProvider.loginWithId(id))
      })

      this.app.get('/login/:id', (req, res) => {
        const { id } = req.params
        if (isNaN(id)) {
          indexRoute(req, res);
        } else {
          console.log(`login: ${id}`)
          this.processLogin(res, this.riderProvider.loginWithId(id), true)
        }
      })
    }

    this.app.get('/profile', this.processRider(rider => rider.getProfile()))
    this.app.get('/positions', this.processRider(rider => rider.getPositions()))
    this.app.get('/riders', this.processRider(rider => rider.getRiders ? rider.getRiders() : Promise.resolve([])))

    this.app.get('/world', this.processRider((rider, req) => {
      const startTime = process.hrtime();

      const event = req.query.event || undefined;

      const interval = (this.riderProvider.count > 40) ? 10000
          : (this.riderProvider.count > 20 ? 5000 : 2500);
      pollInterval.set(interval);

      if (event) {
        rider.setFilter(`event:${this.getEventName(req, true)}`);
      } else if (req.query.all) {
        rider.setFilter(`all:${req.query.all}`);
      }

      return Promise.all([
        this.worldPromise(rider),
        rider.getPositions()
      ]).then(([worldId, positions]) => {
        const token = stravaConnect.getToken(req);
        const stravaPromise = (this.stravaSettings && token) ?
              this.stravaSegments.get(token, worldId, positions, stravaConnect.getSettings(req))
              : Promise.resolve(null);

        const pointsOfInterest = new PointsOfInterest(this.settings ? this.settings.worlds : null, worldId, event);
        pointsOfInterest.initialiseRiderProvider(this.riderProvider);

        return Promise.all([
          stravaPromise,
          pointsOfInterest.getPoints(positions),
          rider.getCurrentEventFromPositions && rider.getCurrentEventFromPositions(positions)
        ]).then(([strava, points, currentEvent]) => {
            const endTime = process.hrtime(startTime);
            const duration = endTime[0] * 1000 + endTime[1] / 1000000;

            if (duration > 100) {
              console.log(`/world: ${Math.round(duration * 10)/10}ms for ${positions ? positions.length : 0} positions`);
            }

            const modifiedPositions = pointsOfInterest.modifyPositions(positions);

            return {
              worldId, strava, points,
              positions: modifiedPositions,
              infoPanel: pointsOfInterest.getInfoPanel(),
              interval,
              currentEvent
            };
          })
      })
    }))

    this.app.options('/world', respondCORS)
    this.app.post('/world', this.processRider((rider, req) => {
      const worldId = req.body.world;
      rider.setWorld(worldId);
      return Promise.resolve({});
    }))

    this.app.options('/riderfilter', respondCORS)
    this.app.get('/riderfilter', this.processRider((rider, req) => {
      return rider.getFilterDetails();
    }))
    this.app.post('/riderfilter', this.processRider((rider, req) => {
      const filter = req.body.filter;
      rider.setFilter(filter && filter.length >= 2 ? filter.toLowerCase() : undefined);
      return rider.getFilterDetails();
    }))

    this.app.get('/strava-effort/:segmentId', this.processRider((rider, req) => {
      const { segmentId } = req.params;
      const token = stravaConnect.getToken(req);
      if (this.stravaSettings && token) {
        return this.worldPromise(rider)
          .then(worldId => this.stravaSegments.segmentEffort(token, worldId, segmentId, stravaConnect.getSettings(req)))
      } else {
				throw new Error('Not connected to strava')
      }
    }))

    this.app.get('/strava-segments', this.processRider((rider, req) => {
      const { ids } = req.query;
      const token = stravaConnect.getToken(req);
      if (!token) {
				throw new Error('Not connected to strava')
      } else if (!ids) {
        throw new Error('No segments requested');
      } else {
        return this.worldPromise(rider)
          .then(worldId => this.stravaSegments.segments(token, worldId, ids, stravaConnect.getSettings(req)))
      }
    }))

    this.app.get('/activities/:playerId', this.processRider((rider, req) => {
      // const { playerId } = req.params;
      // return this.worldPromise(rider)
      //   .then(worldId => rider.getActivities(worldId, playerId))
      const token = stravaConnect.getToken(req);
      if (!token) {
				throw new Error('Not connected to strava')
      } else {
        return this.worldPromise(rider)
          .then(worldId => {
            return this.stravaSegments.activities(token, worldId, stravaConnect.getSettings(req))
          })
      }
    }))

    this.app.get('/rider/:riderId/activity/:activityId', this.processRider((rider, req) => {
      // return rider.getGhosts().getActivity(req.params.riderId, req.params.activityId)
      const { activityId } = req.params;
      const token = stravaConnect.getToken(req);
      if (!token) {
				throw new Error('Not connected to strava')
      } else {
        return this.worldPromise(rider)
          .then(worldId => {
            return this.stravaSegments.activity(token, worldId, activityId, stravaConnect.getSettings(req))
          })
      }
    }))

    this.app.get('/ghosts', this.processRider((rider, req) => Promise.resolve(rider.getGhosts ? rider.getGhosts().getList() : null)))
    this.app.options('/ghosts', respondCORS)
    this.app.put('/ghosts', this.processRider((rider, req) => {
      // return rider.getGhosts().addGhost(parseInt(req.body.riderId), parseInt(req.body.activityId))
      const { activityId } = req.body;
      const token = stravaConnect.getToken(req);
      if (!token) {
				throw new Error('Not connected to strava')
      } else {
        return this.worldPromise(rider)
          .then(worldId => {
            return this.stravaSegments.activity(token, worldId, activityId, stravaConnect.getSettings(req))
                .then(activity => {
                  return rider.getGhosts().addGhostFromActivity(rider.riderId, worldId, activity)
                });
          })
      }
    }))
    this.app.delete('/ghosts', this.processRider((rider, req) => Promise.resolve(rider.getGhosts().removeAll())))

    this.app.options('/ghosts/:ghostId', respondCORS)
    this.app.delete('/ghosts/:ghostId', this.processRider((rider, req) => Promise.resolve(rider.getGhosts().removeGhost(parseInt(req.params.ghostId)))))

    this.app.options('/ghosts/post', respondCORS)
    this.app.post('/ghosts/regroup', this.processRider((rider, req) => Promise.resolve(rider.regroupGhosts())))

    if (this.riderProvider.login) {
      this.app.ws('/listen', (ws, req) => {
        const cookie = req.cookies.zssToken;
        const rider = this.riderProvider.getRider(cookie);

        if (rider) {
          const sendWorld = worldId => send('world', { worldId });
          const sendPositions = positions => {
            send('positions', positions);

            const token = stravaConnect.getToken(req);
            if (this.stravaSettings && token) {
              this.worldPromise(rider).then(worldId =>
                this.stravaSegments.get(token, worldId, positions, stravaConnect.getSettings(req))
                  .then(strava => {
                    send('strava', strava);
                  })
              )
            }
          }

          let unsubscribeRider;

          const unsubscribe = () => {
            rider.removeListener('positions', sendPositions);
            rider.removeListener('world', sendWorld);

            if (unsubscribeRider) unsubscribeRider();
          }
          ws.on('close', unsubscribe);

          if (this.riderProvider.subscribe) {
            unsubscribeRider = this.riderProvider.subscribe(cookie);
          }

          const send = (name, data) => {
            try {
              ws.send(JSON.stringify({ name, data }));
            } catch (ex) {
              unsubscribe();
              console.error(ex);
              ws.close();
            }
          }

          const world = rider.getCurrentWorld ? rider.getCurrentWorld() : rider.getWorld();
          if (world) sendWorld(world);

          rider
            .on('positions', sendPositions)
            .on('world', sendWorld)
        }
      });
    }

    this.app.get('/map.svg', (req, res) => {
      const worldId = req.query.world || undefined;
      this.map.getSvg(worldId).then(data => sendImg(res, data, 'image/svg+xml'));
    })

    this.app.get('/mapSettings', this.processRider((rider, req) => {
      const event = this.getEventName(req);

      const worldId = req.query.world || undefined;
      const overlay = req.query.overlay === 'true';
      return this.map.getSettings(worldId, overlay, event);
    }))

    this.app.get('/host', (req, res) => {
      if (this.hostData) {
        this.hostData.getHostInfo().then(respondJson(res));
      } else {
        sendJson(res, {});
      }
    })

    this.app.get('/events', (req, res) => {
      if (this.riderProvider.getEvents) {
        this.riderProvider.getEvents().then(events => {
          sendJson(res, { events });
        });
      } else {
        sendJson(res, { events: [] });
      }
    })

    const indexRoute = (req, res) => {
      if (req.accepts('html')) {
				// respond with html index page
        const htmlPath = path.resolve(`${__dirname}/../public/index.html`);
        if (this.siteSettings) {
          res.send(insertSiteSettings(htmlPath, this.siteSettings));
        } else {
          res.sendFile(htmlPath);
        }
        return;
      }
      res.status(404);

      // respond with json
      if (req.accepts('json')) {
        res.send({ error: 'Not found' });
        return;
      }
      // default to plain-text. send()
      res.type('txt').send('Not found');
    };

    this.app.get('/', doForceSSL, (req, res) => {
      indexRoute(req, res);
    })
    this.app.get('/zwiftquest', doForceSSL, (req, res) => {
      this.allowAnonymous(req, res);
      indexRoute(req, res);
    })

    if (this.siteSettings && this.siteSettings.static) {
      const { route, path } = this.siteSettings.static
      // Static hosting for web client
      this.app.use(route,
        (req, res, next) => {
          setAllowOrigin(res);
          next();
        },
        express.static(path))
    }

		// Static hosting for web client
    this.app.use(express.static(`${__dirname}/../public`))

    // Handle 404s (React app routing)
    this.app.use(doForceSSL);
    this.app.use(indexRoute);
  }

  maintenanceMode() {
    this.app = express();

    this.app.get('/', (req, res) => {
      const htmlPath = path.resolve(`${__dirname}/../public/index.html`);
      res.sendFile(htmlPath);
    });
    this.app.use(express.static(`${__dirname}/../public`))

    this.app.use((req, res) => {
      setAllowOrigin(res);
      res.status(503);
      
      if (this.siteSettings && this.siteSettings.offline) {
        res.sendFile(this.siteSettings.offline);
      } else {
        res.send('Site is offline');
      }
    })
  }

  allowAnonymous(req, res) {
    const cookie = req.cookies.zssToken;
    const rider = this.riderProvider.getRider(cookie);
    if (!rider && this.riderProvider.loginAnonymous) {
      const result = this.riderProvider.loginAnonymous();

      const expires = new Date()
      expires.setFullYear(expires.getFullYear() + 1);
      res.cookie('zssToken', result.cookie, { path: '/', httpOnly: true, expires });
    }
  }

  start(port) {
    this.port = port;
    this.server = this.app.listen(port, () => {
      console.log(`Listening on port ${port}`);
    })
  }

  stop() {
    if (this.server) {
      this.server.close();
      console.log(`Stopped listening on port ${this.port}`);
      this.server = null;
    }
  }

  processLogin(res, promise, redirect = false) {
		promise
      .then(result => {
        console.log(`login successful (${result.id} - ${result.firstName} ${result.lastName})`)

        if (this.siteSettings && this.siteSettings.approvalRequired
            && result.privacy && result.privacy.approvalRequired) {
          res.status(403);
          sendJson(res, {
            status: 403,
            statusText: this.siteSettings.approvalRequired.message,
            alt: this.siteSettings.approvalRequired.alt
          })
          return;
        }

        const expires = new Date()
        expires.setFullYear(expires.getFullYear() + 1);
        res.cookie('zssToken', result.cookie, { path: '/', httpOnly: true, expires });

        if (redirect)
          res.redirect('/')
        else
          sendJson(res, { message: 'ok' })
      })
      .catch(err => {
        console.log('login failed - ', err)
        const { status, statusText } = err.response;
        res.status(status);

        if (redirect)
          res.redirect('/login')
        else if (err.response.data === 'partner.not.authorized') {
          sendJson(res, {
            statusText: 'Please opt-in to sharing Zwift activities with ZwiftGPS',
            alt: {
              message: 'You\'ll need to opt-in before ZwiftGPS can find you riding in Zwift',
              link: { addr: 'https://my.zwift.com/profile/connections', caption: 'OPT-IN: Zwift Connections' }
            }
          });
        }
        else {
          sendJson(res, { status, statusText });
        }
      })
  }

	processRider(callbackFn) {
    return (req, res) => {
		  const cookie = req.cookies.zssToken;
      const event = this.getEventName(req, true);
      const rider = this.riderProvider.getRider(cookie, event);
			if (rider) {
        const promise = rider.restorePromise ? rider.restorePromise : Promise.resolve();
        promise.then(() => {
          callbackFn(rider, req)
            .then(respondJson(res))
            .catch(responseError(res, req.url, rider));
        });
			} else {
				res.status(401);
				sendJson(res, { status: 401, statusText: 'Unauthorised' });
			}
		}
  }
  
  getEventName(req, includeCode) {
    let event = req.query.event || undefined;
    if (event) {
      const eventParts = event.split('-');
      event = (includeCode && eventParts.length > 1) ? `${eventParts[0]}-${eventParts[1]}` : eventParts[0];
    }
    return event ? event.toLowerCase() : undefined;
  }

  worldPromise(rider) {
    const worldId = rider.getCurrentWorld ? rider.getCurrentWorld() : rider.getWorld()
    if (worldId) {
      return Promise.resolve(worldId);
    } else {
      return this.map.getWorld()
    }
  }

}
module.exports = Server;

function responseError(res, url = 'unknown', rider) {
  return function (err) {
    const message = errorMessage(err);
    console.log(`Error for ${rider ? rider.riderId : '{unknown}'} at url "${url}": ${message}`);
    if (err.response) {
      if (err.response.data === 'partner.not.authorized') {
        res.status(401).send(message);
      } else {
        res.status(err.response.status).send(message);
      }
    } else {
      res.status(500).send(message);
    }
  }
}

function errorMessage(ex) {
  return (ex && ex.response && ex.response.status)
      ? `- ${ex.response.status} (${ex.response.statusText})`
      : `${ex.message}\r\n${ex.stack}`;
}

function respondJson(res) {
  return function (data) {
    sendJson(res, data);
  }
}

function respondCORS(req, res) {
  sendJson(res, {});
}

function sendJson(res, data) {
  setAllowOrigin(res);
  res.setHeader('Cache-Control', 'nocache');
  res.setHeader('Last-Modified', (new Date()).toUTCString());
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", 0);
  res.send(data);
}

function sendImg(res, data, contentType) {
  setAllowOrigin(res);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.send(data);
}

function setAllowOrigin(res) {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8888');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', true);
}
