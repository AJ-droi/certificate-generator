-- Separate database for `npm test` (the tests wipe their database).
CREATE DATABASE certificate_generator_test;
-- Separate database for the browser (Playwright) tests.
CREATE DATABASE certificate_generator_ui_test;
