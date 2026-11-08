require 'xcodeproj'

# Called by the generated Podfile, in CocoaPods' own Ruby/gem environment.
# The tracked project/configuration and shipping schemes are never edited.
module OctantOfflineNativeTests
  def self.prepare(ios_directory, test_source)
    project_path = File.join(ios_directory, 'Octant.xcodeproj')
    project = Xcodeproj::Project.open(project_path)
    app = project.targets.find { |target| target.name == 'Octant' && target.product_type == 'com.apple.product-type.application' }
    raise 'The generated Octant application target is unavailable' unless app
    name = 'OctantOfflineNativeTests'
    raise 'The disposable acceptance target already exists' if project.targets.any? { |target| target.name == name }
    target = project.new_target(:ui_test_bundle, name, :ios, '17.0', nil, :swift)
    target.add_dependency(app)
    source = project.main_group.new_group(name).new_file(test_source)
    target.add_file_references([source])
    target.build_configurations.each do |configuration|
      configuration.build_settings.merge!({
        'PRODUCT_BUNDLE_IDENTIFIER' => 'app.octant.mobile.offline-native-tests',
        'GENERATE_INFOPLIST_FILE' => 'YES',
        'SWIFT_VERSION' => '6.0',
        'TEST_TARGET_NAME' => app.name,
        'TARGETED_DEVICE_FAMILY' => '1',
        'CODE_SIGNING_ALLOWED' => 'NO',
      })
    end
    project.root_object.attributes['TargetAttributes'] ||= {}
    project.root_object.attributes['TargetAttributes'][target.uuid] = { 'TestTargetID' => app.uuid }
    project.save
    scheme = Xcodeproj::XCScheme.new
    scheme.configure_with_targets(app, target, launch_target: true)
    scheme.test_action.build_configuration = 'Release'
    scheme.save_as(project_path, name, true)
  end
end
