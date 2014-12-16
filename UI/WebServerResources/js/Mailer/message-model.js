/* -*- Mode: javascript; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

(function() {
  'use strict';

  /**
   * @name Message
   * @constructor
   * @param {string} accountId - the account ID
   * @param {string} mailboxPath - an array of the mailbox path components
   * @param {object} futureAddressBookData - either an object literal or a promise
   */
  function Message(accountId, mailbox, futureMessageData) {
    this.accountId = accountId;
    this.$mailbox = mailbox;
    // Data is immediately available
    if (typeof futureMessageData.then !== 'function') {
      //console.debug(JSON.stringify(futureMessageData, undefined, 2));
      angular.extend(this, futureMessageData);
      this.id = this.$absolutePath();
      this.$formatFullAddresses();
    }
    else {
      // The promise will be unwrapped first
      this.$unwrap(futureMessageData);
    }
  }

  /**
   * @memberof Message
   * @desc The factory we'll use to register with Angular
   * @returns the Message constructor
   */
  Message.$factory = ['$q', '$timeout', '$log', '$sce', 'sgSettings', 'sgResource', function($q, $timeout, $log, $sce, Settings, Resource) {
    angular.extend(Message, {
      $q: $q,
      $timeout: $timeout,
      $log: $log,
      $sce: $sce,
      $$resource: new Resource(Settings.baseURL, Settings.activeUser)
    });

    return Message; // return constructor
  }];

  /* Factory registration in Angular module */
  angular.module('SOGo.MailerUI')
    .factory('sgMessage', Message.$factory);

  /**
   * @function $absolutePath
   * @memberof Message.prototype
   * @desc Build the path of the message
   * @returns a string representing the path relative to the mail module
   */
  Message.prototype.$absolutePath = function(options) {
    var path;

    path = _.map(this.$mailbox.path.split('/'), function(component) {
      return 'folder' + component.asCSSIdentifier();
    });
    path.splice(0, 0, this.accountId); // insert account ID
    if (options && options.asDraft && this.draftId) {
      path.push(this.draftId); // add draft ID
    }
    else {
      path.push(this.uid); // add message UID
    }

    return path.join('/');
  };

  /**
   * @function $setUID
   * @memberof Message.prototype
   * @desc Change the UID of the message. This happens when saving a draft.
   * @param {number} uid - the new message UID
   */
  Message.prototype.$setUID = function(uid) {
    var oldUID = this.uid || -1;

    if (oldUID != uid) {
      this.uid = uid;
      this.id = this.$absolutePath();
      if (oldUID > -1) {
        this.$mailbox.uidsMap[uid] = this.$mailbox.uidsMap[oldUID];
        this.$mailbox.uidsMap[oldUID] = null;
      }
    }
  };

  /**
   * @function $formatFullAddresses
   * @memberof Message.prototype
   * @desc Format all sender and recipients addresses with a complete description (name <email>).
   */
  Message.prototype.$formatFullAddresses = function() {
    var _this = this;

    // Build long representation of email addresses
    _.each(['from', 'to', 'cc', 'bcc', 'reply-to'], function(type) {
      _.each(_this[type], function(data, i) {
        if (data.name && data.name != data.email)
          data.full = data.name + ' <' + data.email + '>';
        else
          data.full = '<' + data.email + '>';
      });
    });
  };

  /**
   * @function $shortAddress
   * @memberof Message.prototype
   * @desc Format the first address of a specific type with a short description.
   * @returns a string of the name or the email of the envelope address type
   */
  Message.prototype.$shortAddress = function(type) {
    var address = '';
    if (this[type] && this[type].length > 0) {
      address = this[type][0].name || this[type][0].email || '';
    }

    return address;
  };

  /**
   * @function $content
   * @memberof Message.prototype
   * @desc Get the message body as accepted by SCE (Angular Strict Contextual Escaping).
   * @returns the HTML representation of the body
   */
  Message.prototype.$content = function() {
    return Message.$sce.trustAs('html', this.content);
  };

  /**
   * @function $editableContent
   * @memberof Message.prototype
   * @desc First, fetch the draft ID that corresponds to the temporary draft object on the SOGo server.
   * Secondly, fetch the editable message body along with other metadata such as the recipients.
   * @returns the HTML representation of the body
   */
  Message.prototype.$editableContent = function() {
    var _this = this,
        deferred = Message.$q.defer();

    Message.$$resource.fetch(this.id, 'edit').then(function(data) {
      angular.extend(_this, data);
      Message.$$resource.fetch(_this.$absolutePath({asDraft: true}), 'edit').then(function(data) {
        Message.$log.debug('editable = ' + JSON.stringify(data, undefined, 2));
        _this.editable = data;
        deferred.resolve(data.text);
      }, deferred.reject);
    }, deferred.reject);

    return deferred.promise;
  };

  /**
   * @function $update
   * @memberof Message.prototype
   * @desc Fetch the viewable message body along with other metadata such as the list of attachments.
   * @returns a promise of the HTTP operation
   */
  Message.prototype.$update = function() {
    var futureMessageData;

    futureMessageData = Message.$$resource.fetch(this.id, 'view');

    return this.$unwrap(futureMessageData);
  };

  /**
   * @function $save
   * @memberof Message.prototype
   * @desc Save the message to the server.
   * @returns a promise of the HTTP operation
   */
  Message.prototype.$save = function() {
    var _this = this,
        data = this.editable;

    // Flatten recipient addresses
    _.each(['to', 'cc', 'bcc', 'reply-to'], function(type) {
      if (data[type]) {
        data[type] = _.pluck(data[type], 'text');
      }
    });
    Message.$log.debug('save = ' + JSON.stringify(data, undefined, 2));

    return Message.$$resource.save(this.$absolutePath({asDraft: true}), data).then(function(response) {
      Message.$log.debug('save = ' + JSON.stringify(response, undefined, 2));
      _this.$setUID(response.uid);
      _this.$update(); // fetch a new viewable version of the message
    });
  };

  /**
   * @function $send
   * @memberof Message.prototype
   * @desc Send the message.
   * @returns a promise of the HTTP operation
   */
  Message.prototype.$send = function() {
    var data = angular.copy(this.editable),
        deferred = Message.$q.defer();

    // Flatten recipient addresses
    _.each(['to', 'cc', 'bcc', 'reply-to'], function(type) {
      if (data[type]) {
        data[type] = _.pluck(data[type], 'text');
      }
    });
    Message.$log.debug('send = ' + JSON.stringify(data, undefined, 2));

    Message.$$resource.post(this.$absolutePath({asDraft: true}), 'send', data).then(function(data) {
      if (data.status == 'success') {
        deferred.resolve(data);
      }
      else {
        deferred.reject(data);
      }
    });

    return deferred.promise;
  };

  /**
   * @function $unwrap
   * @memberof Message.prototype
   * @desc Unwrap a promise. 
   * @param {promise} futureMessageData - a promise of some of the Message's data
   */
  Message.prototype.$unwrap = function(futureMessageData) {
    var _this = this,
        deferred = Message.$q.defer();

    // Expose the promise
      this.$futureMessageData = futureMessageData;

    // Resolve the promise
    this.$futureMessageData.then(function(data) {
      // Calling $timeout will force Angular to refresh the view
      Message.$timeout(function() {
        angular.extend(_this, data);
        _this.id = _this.$absolutePath();
        _this.$formatFullAddresses();
        deferred.resolve(_this);
      });
    }, function(data) {
      angular.extend(_this, data);
      _this.isError = true;
      Message.$log.error(_this.error);
      deferred.reject();
    });

    return deferred.promise;
  };

  /**
   * @function $omit
   * @memberof Message.prototype
   * @desc Return a sanitized object used to send to the server.
   * @return an object literal copy of the Message instance
   */
  Message.prototype.$omit = function() {
    var message = {};
    angular.forEach(this, function(value, key) {
      if (key != 'constructor' && key[0] != '$') {
        message[key] = value;
      }
    });

    // Format addresses as arrays
    _.each(['from', 'to', 'cc', 'bcc', 'reply-to'], function(type) {
      if (message[type])
        message[type] = _.invoke(message[type].split(','), 'trim');
    });

    //Message.$log.debug(JSON.stringify(message, undefined, 2));
    return message;
  };

})();
