﻿const NodeCache = require('node-cache')
const EventEmitter = require('events');
const Ghosts = require('./ghosts');
const AllRiders = require('./allRiders');
const Events = require('./events');
const Profile = require('./profile');

const userCache = new NodeCache({ stdTTL: 30, checkperiod: 10, useClones: false });
const riderCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 10, useClones: false });

const MAX_RIDERS = 40;

const GROUP_COLOURS = [
  'red',
  'green',
  'blue',
  'yellow'
];

const EVENT_PREFIX = "event:";
const ALL_PREFIX = "all:";

class Rider extends EventEmitter {
  constructor(account, riderId, riderStatusFn) {
    super();

    this.account = account;
    this.allRiders = new AllRiders(account);
    this.events = new Events(account);
    this.profile = new Profile(account);
    this.riderId = riderId;
    this.ghosts = Ghosts.forRider(account, riderId);
    this.riderStatusFn = riderStatusFn || this.fallbackRiderStatusFn

    this.cacheKey = `rider-${riderId}`;

    this.state = riderCache.get(this.cacheKey);
    if (this.state) {
      riderCache.ttl(this.cacheKey);
    } else {
      this.state = {
        worldId: undefined,
        statusWorldId: undefined,
        filter: undefined
      };
    }
  }

  store() {
    riderCache.set(this.cacheKey, this.state);
  }

  setRiderId(riderId, riderStatusFn) {
    this.riderId = riderId;
    this.riderStatusFn = riderStatusFn || this.fallbackRiderStatusFn
  }

  setWorld(worldId) {
    if (this.state.worldId !== worldId) {
      this.state.worldId = worldId;
      this.store();
      this.emit('world', this.state.worldId);
    }
  }

  getWorld() {
    return this.state.worldId;
  }

  setFilter(filter) {
    if (this.state.filter !== filter) {
      this.state.filter = filter;
      this.store();
    }
  }

  getFilter() {
    return this.state.filter;
  }

  getCurrentWorld() {
    return this.state.worldId || this.state.statusWorldId;
  }

  pollPositions() {
    this.getPositions()
      .then(positions => {
        this.emit('positions', positions);
      })
      .catch(err => {
        console.error(err);
      });
  }

  getGhosts() {
    return this.ghosts;
  }

  regroupGhosts() {
    return this.getPositions().then(positions => {
      if (positions.length > 0) {
        return this.getGhosts().regroup(positions[0]);
      }
			return []
    })
  }

  getProfile() {
    if (!this.riderId) {
      return Promise.resolve({
        anonymous: true,
        useMetric: true
      });
    } else if (this.getProfileRequest) {
      return this.getProfileRequest;
    } else {
      this.getProfileRequest = this.profile.getProfile(this.riderId)
          .then(profile => {
            if (profile) {
              userCache.set(`rider-${this.riderId}`, profile);
            }

            this.getProfileRequest = null;
            return profile;
          });
      return this.getProfileRequest;
    }
  }

  requestRidingFriends() {
    if (!this.riderId) {
      return Promise.resolve([]);
    }

    return this.getProfile().then(profile => {
      if (!profile) return [];

      profile.me = true;
      return this.getFriends(profile.id).then(friends => {
        return [profile].concat(friends.map(this.friendMap));
      });
		});
  }

	getFriends(riderId) {
    return this.profile.getFollowees(riderId);
	}

  getActivities(worldId, riderId) {
    const matchWorld = parseInt(worldId);

    return new Promise(resolve => {
      this.account.getProfile(riderId).activities(0, 30)
        .then(activities => {
          resolve(activities.filter(a => a.worldId === matchWorld));
      }).catch(ex => {
        console.log(`Failed to get activities for ${riderId}${errorMessage(ex)}`);
        resolve(null);
      });
    });
  }

  requestRidingNow() {
    return this.state.filter
      ? this.requestRidingFiltered()
            .then(riders => this.addMeToRiders(riders))
      : this.requestRidingFriends();
  }

  requestRidingFiltered() {
    if (this.state.filter.indexOf(EVENT_PREFIX) === 0) {
      const eventSearch = this.state.filter.substring(EVENT_PREFIX.length);
      return this.requestRidingEvent(eventSearch);
    } else if (this.state.filter.indexOf(ALL_PREFIX) === 0) {
      const allSearch = this.state.filter.substring(ALL_PREFIX.length);
      return this.requestAll(allSearch);
    } else {
      return this.requestRidingFilterName();
    }
  }

  filterByCurrentlyRiding(riders) {
    return this.allRiders.get().then(worldRiders =>
      riders.filter(r => worldRiders.filter(wr => wr.playerId === r.id).length > 0)
    );
  }

  addMeToRiders(riders) {
    const eventSearch = (this.state.filter.indexOf(EVENT_PREFIX) === 0)
        ? this.state.filter.substring(EVENT_PREFIX.length) : null;

    let mePromise;
    if (this.riderId && !riders.find(r => r.id == this.riderId)) {
      mePromise = this.getProfile().then(profile => {
        if (!profile) return riders;

        profile.me = true;

        if (eventSearch && isNaN(eventSearch)) {
          this.events.setRidingInEvent(eventSearch, profile);
        }

        return [profile].concat(riders);
      })
    } else {
      mePromise = Promise.resolve(riders);
    }

    if (eventSearch && isNaN(eventSearch) && riders.length === 0) {
      // Add people tracking the same event if no riders in Zwift event
      return mePromise.then(riders => {
        const eventRiders = this.events.getRidersInEvent(eventSearch)
            .filter(er => er && !riders.find(r => r.id === er.id))
            .map(er => Object.assign({}, er, { me: false }));
        return riders.concat(eventRiders);
      });
    } else {
      return mePromise;
    }
  }

  requestRidingFilterName() {
    return this.allRiders.get()
      .then(worldRiders =>
        worldRiders
          .filter(r => this.filterWorldRider(r))
          .map(r => this.mapWorldRider(r))
    );
  }

  requestRidingEvent(eventSearch) {
    return this.events.findMatchingEvent(eventSearch).then(event => {
      if (event) {
        return Promise.all(
          event.eventSubgroups.map(g => this.getSubgroupRiders(g.id, g.label))
        ).then(groupedRiders => {
          const allRiders = [].concat.apply([], groupedRiders);

          const meRider = allRiders.find(r => r.id == this.riderId);
          if (meRider) {
            if (isNaN(eventSearch)) {
              this.events.setRidingInEvent(eventSearch, meRider);
            }
            allRiders.sort((a, b) =>
              (a.me || b.me) ? (a.me ? -1 : 1)
              : Math.abs(a.group - meRider.group) - Math.abs(b.group - meRider.group)
            );
          }

          return allRiders;
        });
      } else {
        // No matching event
        return [];
      }
    });
  }

  getSubgroupRiders(subGroupId, label) {
    return this.events.getRiders(subGroupId)
      .then(riders => riders.map(r => {
        return Object.assign({}, r, {
          me: r.id == this.riderId,
          group: label
        }
      )}));
  }

  requestAll(allSearch) {
    if (allSearch == 'users') {
      const allUsers = userCache.keys()
          .map(key => userCache.get(key))
          .filter(user => user && user.id);
      return Promise.resolve(allUsers);
    }
    return Promise.resolve([]);
  }

  filterWorldRider(rider) {
    const fullName = `${rider.firstName ? rider.firstName : ''} ${rider.lastName ? rider.lastName: ''}`;
    return fullName.toLowerCase().indexOf(this.state.filter) !== -1;
  }

  mapWorldRider(rider) {
    return {
      id: rider.playerId,
      me: rider.playerId == this.riderId,
      firstName: rider.firstName,
      lastName: rider.lastName,
      male: rider.male,
      playerType: rider.playerType,
      countryCode: rider.countryISOCode
    };
  }

  friendMap(friend) {
    return friend.followeeProfile;
  }

  getPositions() {
    return new Promise(resolve => {
      // id, firstName, lastName
      this.requestRidingNow()
        .then(riders => this.filterByCurrentlyRiding(riders))
        .then(riders => {
          const promises = riders
              .slice(0, MAX_RIDERS)
              .map(r => this.riderPromise(r));

          Promise.all(promises)
            .then(positions => this.filterByWorld(positions))
            .then(positions => this.addGhosts(positions.filter(p => p !== null)))
            .then(positions => resolve(positions));
        }).catch(ex => {
          console.log(`Failed to get positions for ${this.riderId}${errorMessage(ex)}`);
          resolve(null);
        });
    });
  }

  riderPromise(rider) {
    return this.riderStatusFn(rider.id)
      .then(status => {
        if (status) {
          return {
            id: rider.id,
            me: rider.me,
            world: status.world,
            firstName: rider.firstName,
            lastName: rider.lastName,
            distance: status.distance,
            speed: status.speed,
            power: status.power,
            time: status.time,
            climbing: status.climbing,
            x: status.x,
            y: status.y,
            altitude: status.altitude,
            heartrate: status.heartrate,
            wattsPerKG: status.wattsPerKG,
            roadID: status.roadID,
            rideOns: status.rideOns,
            isTurning: status.isTurning,
            isForward: status.isForward,
            roadDirection: status.roadDirection,
            turnSignal: status.turnSignal,
            powerup: status.powerup,
            hasFeatherBoost: status.hasFeatherBoost,
            hasDraftBoost: status.hasDraftBoost,
            hasAeroBoost: status.hasAeroBoost,
            sport: status.sport,
            male: rider.male,
            playerType: rider.playerType,
            contryAlpha3: rider.countryAlpha3,
            countryCode: rider.countryCode,
            weight: rider.weight,
            colour: this.colourFromGroup(rider.group),
            requestTime: status.requestTime,
            next: status.next
          };
        } else {
          return null;
        }
      });
  }

  colourFromGroup(group) {
    return group ? GROUP_COLOURS[group-1] : undefined;
  }

  filterByWorld(positions) {
    const worldId = this.state.worldId || this.getWorldFromPositions(positions);
    if (worldId) {
      return positions.filter(p => p && p.world === worldId)
    } else {
      return positions;
    }
  }

  getWorldFromPositions(positions) {
    const mePosition = positions.find(p => p && p.me);
    const statusWorldId = mePosition ? mePosition.world : undefined;

    if (this.state.statusWorldId !== statusWorldId) {
      this.state.statusWorldId = statusWorldId;
      this.store();
    }
    return this.state.statusWorldId;
  }

  addGhosts(positions) {
    const ghostPositions = this.ghosts.getPositions();
    return positions.concat(ghostPositions);
  }

  fallbackRiderStatusFn(id) {
    return new Promise(resolve => {
      this.account.getWorld(1).riderStatus(id)
          .then(status => {
            resolve(status);
          })
          .catch(ex => {
            console.log(`Failed to get status for ${id}${errorMessage(ex)}`);
            resolve(null);
          });
    });
  }

  sendRideOn(targetId) {
    return Promise.resolve();
  }
}
Rider.userCount = () => {
  return userCache.keys().length;
}
Rider.userCache = userCache;
Rider.riderCache = riderCache;
module.exports = Rider;

function errorMessage(ex) {
  return (ex && ex.response && ex.response.status)
      ? `- ${ex.response.status} (${ex.response.statusText})`
      : ` - ${ex.message}`;
}