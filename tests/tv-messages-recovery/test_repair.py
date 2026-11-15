import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT=Path(__file__).resolve().parents[2]/'scripts/repair-tv-messages-legacy.py'
spec=importlib.util.spec_from_file_location('repair',SCRIPT)
repair=importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
APP='''import express from "express";
import authRoutes from "./modules/auth/auth.routes.js";
export function createApp() {
  const app = express();
  app.use(apiLimiter);
  app.use("/api/v1/auth", authRoutes);
  return app;
}
'''
NEW_IMPORTS='''import tvMessagePanelRoutes from "./modules/tv-messages/panel.routes.js";
import tvMessageDeviceRoutes from "./modules/tv-messages/device.routes.js";
'''
NEW_MOUNTS='''  app.use("/api/v1/client/tv-messages", tvMessageDeviceRoutes);
  app.use("/api/v1/tv-messages", tvMessagePanelRoutes);
'''
OLD_IMPORT=repair.OLD_IMPORT+'\n'
OLD_MOUNTS='''  app.use("/api/v1/tv-messages", panelMessages);
  app.use("/api/v1/client/messages", clientMessages);
'''
class MigrationRecoveryTests(unittest.TestCase):
    def test_old_routes_remain_untouched(self):
        src=OLD_IMPORT+APP.replace('  app.use("/api/v1/auth", authRoutes);',OLD_MOUNTS+'  app.use("/api/v1/auth", authRoutes);')
        self.assertEqual(repair.transform(src),src)
    def test_replaces_only_new_routes(self):
        src=NEW_IMPORTS+APP.replace('  app.use("/api/v1/auth", authRoutes);',NEW_MOUNTS+'  app.use("/api/v1/auth", authRoutes);')
        fixed=repair.transform(src)
        for forbidden in ('tvMessagePanelRoutes','tvMessageDeviceRoutes'):
            self.assertNotIn(forbidden,fixed)
        self.assertEqual(fixed.count('"/api/v1/tv-messages", panelMessages'),1)
        self.assertEqual(fixed.count('"/api/v1/client/messages", clientMessages'),1)
        self.assertEqual(repair.transform(fixed),fixed)
    def test_mixed_old_and_new_removes_new(self):
        src=OLD_IMPORT+NEW_IMPORTS+APP.replace('  app.use("/api/v1/auth", authRoutes);',OLD_MOUNTS+NEW_MOUNTS+'  app.use("/api/v1/auth", authRoutes);')
        fixed=repair.transform(src)
        self.assertEqual(fixed.count('"/api/v1/tv-messages", panelMessages'),1)
        self.assertNotIn('tvMessagePanelRoutes',fixed)
    def test_unknown_app_is_rejected(self):
        with self.assertRaises(ValueError):repair.transform('export default {}')
    def test_unknown_extra_usage_is_rejected(self):
        with self.assertRaises(ValueError):repair.transform(APP+'console.log(tvMessagePanelRoutes);')
    def test_unknown_migration_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'src/modules/tv-messages').mkdir(parents=True);(root/'src/db/migrations').mkdir(parents=True)
            (root/'src/app.js').write_text(APP)
            (root/'src/modules/tv-messages/routes.js').write_text('export const panelMessages=Router();export const clientMessages=Router();sender_id')
            (root/'src/db/migrations/20261212000001-tv-messages.cjs').write_text('sender_id')
            bad=root/'src/db/migrations/20261217000001-tv-messages.cjs';bad.write_text('DIFFERENT MIGRATION')
            with self.assertRaises(ValueError):repair.validate_repository(root)
            self.assertEqual(bad.read_text(),'DIFFERENT MIGRATION')

if __name__=='__main__':unittest.main()
