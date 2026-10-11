'use strict';

// Ward registers. `phone` is matched on the last 10 digits, so country codes
// on an incoming WhatsApp message still resolve.
// `name` is the family head, `registeredMembers` the household size on record
// — quota is computed from this number, never from the SMS.
const HOUSEHOLDS = [
  // --- Ward 7 ---
  { id: 'HH-001', houseNo: '7/112', name: 'Yash Sinha', phone: '7762911156', ward: 'Ward 7', registeredMembers: 4 },
  { id: 'HH-002', houseNo: '7/118', name: 'Animesh Patra', phone: '7908717348', ward: 'Ward 7', registeredMembers: 6 },
  // { id: 'HH-003', houseNo: '7/124', name: 'Fatima Sheikh', phone: '9810000003', ward: 'Ward 7', registeredMembers: 3 },
  // { id: 'HH-004', houseNo: '7/131', name: 'Devraj Gaikwad', phone: '9810000004', ward: 'Ward 7', registeredMembers: 5 },
  // { id: 'HH-005', houseNo: '7/137', name: 'Anita Pawar', phone: '9810000005', ward: 'Ward 7', registeredMembers: 2 },
  // { id: 'HH-006', houseNo: '7/140', name: 'Imran Qureshi', phone: '9810000006', ward: 'Ward 7', registeredMembers: 7 },

  // --- Ward 12 ---
  { id: 'HH-007', houseNo: '12/04', name: 'Arjun Patil', phone: '9810000007', ward: 'Ward 12', registeredMembers: 5 },
  { id: 'HH-008', houseNo: '12/09', name: 'Lakshmi Nair', phone: '9810000008', ward: 'Ward 12', registeredMembers: 2 },
  { id: 'HH-009', houseNo: '12/15', name: 'Mohan Kumar', phone: '9810000009', ward: 'Ward 12', registeredMembers: 7 },
  { id: 'HH-010', houseNo: '12/21', name: 'Shabana Khan', phone: '9810000010', ward: 'Ward 12', registeredMembers: 4 },
  { id: 'HH-011', houseNo: '12/26', name: 'Gopal Reddy', phone: '9810000011', ward: 'Ward 12', registeredMembers: 3 },
  { id: 'HH-012', houseNo: '12/33', name: 'Kavita Joshi', phone: '9810000012', ward: 'Ward 12', registeredMembers: 6 },

  // --- Ward 19 ---
  { id: 'HH-013', houseNo: '19/02', name: 'Pooja Verma', phone: '9810000013', ward: 'Ward 19', registeredMembers: 4 },
  { id: 'HH-014', houseNo: '19/08', name: 'Iqbal Ansari', phone: '9810000014', ward: 'Ward 19', registeredMembers: 5 },
  { id: 'HH-015', houseNo: '19/13', name: 'Savitri Bai', phone: '9810000015', ward: 'Ward 19', registeredMembers: 3 },
  { id: 'HH-016', houseNo: '19/19', name: 'Harish Chandra', phone: '9810000016', ward: 'Ward 19', registeredMembers: 8 },
  { id: 'HH-017', houseNo: '19/24', name: 'Nasreen Bano', phone: '9810000017', ward: 'Ward 19', registeredMembers: 2 },
];

const WARDS = ['Ward 7', 'Ward 12', 'Ward 19'];

module.exports = { HOUSEHOLDS, WARDS };
