(function () {
  'use strict';
  var ANT = window.ANT || (window.ANT = {});
  var sb = window.sb;
  ANT.audit = {
    log: function (action, entity, entityId, detail) {
      try {
        if (!sb) return;
        var auth = ANT.auth;
        var actor = auth && auth.current ? auth.current() : null;
        var actorId = actor && actor.id ? actor.id : null;
        if (!actorId) return;
        var payload = {
          actor_id: actorId,
          action: String(action || '').slice(0,80),
          entity: entity ? String(entity).slice(0,50) : null,
          entity_id: entityId ? String(entityId).slice(0,120) : null,
          detail: detail || null
        };
        sb().from('audit_log').insert(payload).then(function(){return;}).catch(function(){return;});
      } catch (e) {}
    }
  };
})();