Pod::Spec.new do |s|
  s.name            = 'OctantVideoSave'
  s.version         = '0.1.0'
  s.summary         = 'Save a cached Octant video on iOS'
  s.description     = 'Copies a cached video to a folder chosen in Files.'
  s.license         = 'UNLICENSED'
  s.author          = 'Octant'
  s.homepage        = 'https://octant.sh'
  s.platforms       = { :ios => '16.4' }
  s.swift_version   = '5.9'
  s.source          = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
