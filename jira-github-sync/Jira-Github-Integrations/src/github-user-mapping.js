/*
 * Maps Jira Cloud account IDs to GitHub usernames.
 *
 * The bidirectional sync needs this mapping in both directions:
 * - Jira -> GitHub when a Jira assignee or reviewer should be applied to a PR.
 * - GitHub -> Jira when a PR assignee or requested reviewer should update Jira.
 *
 * Fill each value with the matching GitHub username, for example:
 * '5f46daa1ea5e2f0039c2edac': 'b9-mourud',
 *
 * Keep values empty when a Jira user should not be assigned or requested for
 * review in GitHub. The comments preserve the Jira display names from the user
 * export so each account ID is easier to identify.
 */
export const JIRA_ACCOUNT_ID_TO_GITHUB_USERNAME = {
  // // Sorav - inactive
  // '712020:1b007a71-a176-479a-8291-4be07777e504': '',

  // // Dilawar Singh - inactive (old account)
  // '712020:edac0fb1-c541-4752-ac55-e006a9b367bf': '',

  // Mourud Ishmam Ahmed
  '5f46daa1ea5e2f0039c2edac': 'b9-mourud',

  // // Former user - inactive
  // '712020:9c6bfd27-fd58-4efc-9c69-005c95378205': '',

  // Gurkamal Jandu
  '712020:c1a11f45-d846-4a0c-9411-f023c45d72aa': 'b9-gurkamal',

  // Amman Zaman
  '712020:58fcbad0-49f1-43b0-b90f-da8c415e90bc': 'b9-amman',

  // // Farizul Ahsan - inactive
  // '712020:5979d413-82fd-4dbf-8b69-684d69d1d0c0': '',

  // // Tanvir Ahsan - inactive
  // '712020:f48461fd-a3ed-4d07-aac3-abec15a8a1fe': '',

  // // Naseem Zaman - inactive
  // '712020:3dfb6bfe-9c58-4ad3-8d08-82adb9f501d0': '',

  // Bodhaditya Fouzder
  '712020:44e42a87-0940-4eee-ae34-a7652e25c891': 'b9-aditya',

  // // Zaid Ahsan - inactive
  // '712020:d8c50d1c-89f4-41fa-a227-0cacc76c0cfa': '',

  // // Stathi Tsangaris - inactive
  // '712020:2f227404-6457-48a7-bd05-3c0044561adf': '',

  // Fadel Al Fayed
  '712020:fe06ce70-7c6b-4533-81e5-221290a9e46a': 'b9-fadel',

  // // Kabir Ahmed - inactive
  // '712020:db52ac76-fd20-4fba-b57f-fe7b7ec5d132': '',

  // // Rokibul Hasan - inactive
  // '712020:7f0d92c6-a408-4752-b430-08241c1f2fe6': '',

  // // Sana Sheraz
  // '712020:4160b44a-54b6-4232-a9ad-9d5105eca042': '',

  // // Former user - inactive
  // '712020:8bcba7c9-4c47-4dfb-a856-b9513f7464d2': '',

  // Ahnaf Ahmed
  '712020:c3d96c53-e804-4bcc-827e-c00fcf648a54': 'b9-ahnaf',

  // Dilawar Singh
  '712020:8ec5c85a-36e6-49e6-8546-36ee188b7c39': 'b9-dilawar',

  // // Farizul Ahsan
  // '712020:e86111d7-9f2d-48b8-9695-e2cf50de8341': '',

  // Kabir Ahmed
  '712020:daf4d0c5-3bb9-48f1-8687-ee13f95d3170': 'b9-kabir',

  // // Naseem Zaman
  // '712020:bffc487f-58fb-4062-b722-55e793f4cf90': '',

  // // Tanvir Ahsan
  // '712020:3150cedd-fdb8-4123-a742-fb5b5cfb2999': '',

  // // Vitali Tikhomolov - inactive
  // '712020:cab9f28d-d7fa-4913-8214-1f81f177f73c': '',

  // // Amman Zaman - inactive
  // '5f70caf54d09f70076c0ef11': '',

  // // Waleed Hashmi - inactive
  // '712020:5bb2f3f2-b251-456e-bf1a-8b786bbe96e7': '',

  // Shandy Christian
  '712020:fffac005-4daa-4248-bc0d-c8a0fbe6d148': 'b9-shandy',

  // // Former user - inactive
  // '712020:7e94fcc5-10f5-4d9c-94d8-8f31512c9523': '',

  // Nazmul Ahsan
  '712020:676ec9b1-6e0c-4883-bb8d-31954cf4ffcf': 'b9-nazmul',

  // // Alistar Son
  // '712020:00778638-b735-43a8-bbc4-95100e68f95c': '',

  // Alexander Houghton
  '712020:e5a64c70-4a3a-4256-91ef-420b9ddca995': 'b9-alexander'

  // // Stathios Tsangaris
  // '712020:e1c7398a-4c84-49b3-94a3-df981e822537': ''
};

export const GITHUB_USERNAME_TO_JIRA_ACCOUNT_ID = Object.fromEntries(
  Object.entries(JIRA_ACCOUNT_ID_TO_GITHUB_USERNAME)
    .filter(([, githubUsername]) => Boolean(githubUsername?.trim()))
    .map(([jiraAccountId, githubUsername]) => [githubUsername.trim().toLowerCase(), jiraAccountId])
);
