"use strict";
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(
        `
CREATE FUNCTION deltatv_mask_json(value jsonb, depth integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE output jsonb; BEGIN
 IF depth>8 THEN RETURN to_jsonb('[TRUNCATED]'::text); END IF;
 IF value IS NULL THEN RETURN NULL; END IF;
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT COALESCE(jsonb_object_agg(k,CASE WHEN k ~* '(pass(word)?|token|secret|credential|authorization|cookie|^code$|licensecode|partnercode|refresh|url)' THEN to_jsonb('[REDACTED]'::text) ELSE deltatv_mask_json(v,depth+1) END),'{}'::jsonb) INTO output FROM jsonb_each(value) AS items(k,v);RETURN output;
 WHEN 'array' THEN SELECT COALESCE(jsonb_agg(deltatv_mask_json(v,depth+1)),'[]'::jsonb) INTO output FROM jsonb_array_elements(value) AS items(v);RETURN output;
 WHEN 'string' THEN IF length(value::text)>1600 THEN RETURN to_jsonb('[TRUNCATED]'::text); END IF;RETURN value;
 ELSE RETURN value; END CASE;
END $$;
CREATE FUNCTION deltatv_row_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor jsonb; previous jsonb; current_value jsonb; identifier text;
BEGIN
 actor:=NULLIF(current_setting('deltatv.audit_actor',true),'')::jsonb;
 IF actor IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN current_value:=to_jsonb(NEW); END IF;
 identifier:=COALESCE(current_value->>'id',previous->>'id',current_value->>'key',previous->>'key',current_value->>'partner_id',previous->>'partner_id',current_value->>'activation_id',previous->>'activation_id',current_value->>'admin_user_id',previous->>'admin_user_id');
 INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,result,ip,metadata)
 VALUES('admin',actor->>'id','record.sql.'||lower(TG_OP),left(TG_TABLE_NAME,40),left(identifier,64),'success',actor->>'ip',
 jsonb_strip_nulls(jsonb_build_object('requestId',actor->>'requestId','actorName',actor->>'name','impersonatedUserId',actor->>'impersonatedUserId','before',deltatv_mask_json(previous),'after',deltatv_mask_json(current_value))));
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE item record;BEGIN
 FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('audit_logs','SequelizeMeta') LOOP
  EXECUTE format('CREATE TRIGGER deltatv_row_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION deltatv_row_audit()',item.tablename);
 END LOOP;
END $$;
`,
        { transaction },
      );
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(
        `DO $$ DECLARE item record;BEGIN FOR item IN SELECT event_object_table AS tablename FROM information_schema.triggers WHERE trigger_schema='public' AND trigger_name='deltatv_row_audit' GROUP BY event_object_table LOOP EXECUTE format('DROP TRIGGER deltatv_row_audit ON public.%I',item.tablename);END LOOP;END $$;DROP FUNCTION deltatv_row_audit();DROP FUNCTION deltatv_mask_json(jsonb,integer);`,
        { transaction },
      );
    });
  },
};
