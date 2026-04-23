import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMAIL_ADDRESS_REGEX,
  getEmailFieldError,
  getRequiredFieldError,
  isValidEmailAddress,
} from '../lib/form-validation';

test('EMAIL_ADDRESS_REGEX accepts browser-style valid email addresses', () => {
  assert.match('name@example.com', EMAIL_ADDRESS_REGEX);
  assert.match("o'hara+sales@example.co.uk", EMAIL_ADDRESS_REGEX);
  assert.match('team.member@subdomain.example.io', EMAIL_ADDRESS_REGEX);
});

test('isValidEmailAddress trims and rejects syntactically invalid emails', () => {
  assert.equal(isValidEmailAddress(' valid@example.com '), true);
  assert.equal(isValidEmailAddress('missing-at.example.com'), false);
  assert.equal(isValidEmailAddress('missing-domain@'), false);
  assert.equal(isValidEmailAddress(''), false);
});

test('shared field validation messages stay consistent across forms', () => {
  assert.equal(getRequiredFieldError('', 'your full name'), 'Enter your full name.');
  assert.equal(getRequiredFieldError('Brendan', 'your full name'), null);
  assert.equal(getEmailFieldError('', 'your work email'), 'Enter your work email.');
  assert.equal(getEmailFieldError('not-an-email'), 'Enter a valid email address.');
  assert.equal(getEmailFieldError('founder@example.com'), null);
});
