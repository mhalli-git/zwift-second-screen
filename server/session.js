﻿class Session {
  constructor(rider) {
    this.rider = rider;
    this.interval = null;
    this.subscriptions = 0;
  }

  getRider() {
    return this.rider;
  }

  subscribe() {
    if (this.subscriptions === 0) {
      console.log(`start-polling`);
      this.interval = setInterval(() => {
        this.rider.pollPositions();
      }, 3000);
      this.rider.pollPositions();
    }
    this.subscriptions++;

    let unsubscribed = false;
    return () => {
      if (!unsubscribed) {
        unsubscribed = true;
        this.subscriptions--;

        if (this.subscriptions === 0) {
          console.log(`stop-polling`);
          clearInterval(this.interval);
        }
      }
    }
  }
}
module.exports = Session;
