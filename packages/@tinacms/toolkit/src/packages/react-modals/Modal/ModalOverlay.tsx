/**

Copyright 2021 Forestry.io Holdings, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

*/
import * as React from 'react'

export const ModalOverlay = ({ children }) => {
  return (
    <div className="fixed inset-0 z-modal w-screen h-screen">
      {children}
      <div className="fixed -z-1 inset-0 opacity-80 bg-gradient-to-br from-gray-800 via-gray-900 to-black"></div>
    </div>
  )
}
